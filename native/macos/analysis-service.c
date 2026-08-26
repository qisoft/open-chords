#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <xpc/xpc.h>

extern char **environ;

typedef struct {
  pid_t child;
  xpc_connection_t peer;
} session_t;

static bool entitlement_is_true(CFDictionaryRef entitlements, CFStringRef key) {
  if (entitlements == NULL) return false;
  CFTypeRef value = CFDictionaryGetValue(entitlements, key);
  return value == kCFBooleanTrue;
}

static bool self_has_required_entitlements(void) {
  SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
  if (task == NULL) return false;
  CFTypeRef sandbox = SecTaskCopyValueForEntitlement(
      task, CFSTR("com.apple.security.app-sandbox"), NULL);
  CFTypeRef client = SecTaskCopyValueForEntitlement(
      task, CFSTR("com.apple.security.network.client"), NULL);
  CFTypeRef server = SecTaskCopyValueForEntitlement(
      task, CFSTR("com.apple.security.network.server"), NULL);
  bool valid = sandbox == kCFBooleanTrue && client != kCFBooleanTrue && server != kCFBooleanTrue;
  if (sandbox != NULL) CFRelease(sandbox);
  if (client != NULL) CFRelease(client);
  if (server != NULL) CFRelease(server);
  CFRelease(task);
  return valid;
}

static bool helper_has_required_signature(const char *path) {
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(
      kCFAllocatorDefault, (const UInt8 *)path, strlen(path), false);
  if (url == NULL) return false;
  SecStaticCodeRef code = NULL;
  OSStatus status = SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
  CFRelease(url);
  if (status != errSecSuccess || code == NULL) return false;
  status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate, NULL);
  CFDictionaryRef information = NULL;
  if (status == errSecSuccess) {
    status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information);
  }
  CFDictionaryRef entitlements = information == NULL
      ? NULL
      : CFDictionaryGetValue(information, kSecCodeInfoEntitlementsDict);
  bool valid = status == errSecSuccess &&
      entitlement_is_true(entitlements, CFSTR("com.apple.security.app-sandbox")) &&
      entitlement_is_true(entitlements, CFSTR("com.apple.security.inherit")) &&
      !entitlement_is_true(entitlements, CFSTR("com.apple.security.network.client")) &&
      !entitlement_is_true(entitlements, CFSTR("com.apple.security.network.server"));
  if (information != NULL) CFRelease(information);
  CFRelease(code);
  return valid;
}

static bool canonical_child_of(const char *root, const char *candidate) {
  char real_root[PATH_MAX];
  char real_candidate[PATH_MAX];
  if (realpath(root, real_root) == NULL || realpath(candidate, real_candidate) == NULL) return false;
  size_t root_length = strlen(real_root);
  return strncmp(real_root, real_candidate, root_length) == 0 &&
      (real_candidate[root_length] == '/' || real_candidate[root_length] == '\0');
}

static void fail(int control, const char *reason) {
  dprintf(control, "{\"error\":\"%s\"}\n", reason);
}

static void launch(xpc_connection_t peer, xpc_object_t message) {
  int input = xpc_dictionary_dup_fd(message, "stdin");
  int output = xpc_dictionary_dup_fd(message, "stdout");
  int error_output = xpc_dictionary_dup_fd(message, "stderr");
  int control = xpc_dictionary_dup_fd(message, "control");
  const char *workspace = xpc_dictionary_get_string(message, "workspace");
  const char *runtime_root = xpc_dictionary_get_string(message, "runtime_root");
  const char *executable = xpc_dictionary_get_string(message, "executable");
  xpc_object_t arguments = xpc_dictionary_get_value(message, "arguments");
  if (input < 0 || output < 0 || error_output < 0 || control < 0 || workspace == NULL ||
      runtime_root == NULL || executable == NULL || xpc_get_type(arguments) != XPC_TYPE_ARRAY) {
    fail(control, "invalid_launch_plan");
    if (input >= 0) close(input);
    if (output >= 0) close(output);
    if (error_output >= 0) close(error_output);
    if (control >= 0) close(control);
    return;
  }
  if (xpc_connection_get_context(peer) != NULL) {
    fail(control, "session_already_active");
    close(input);
    close(output);
    close(error_output);
    close(control);
    return;
  }
  const char *container = getenv("HOME");
  if (container == NULL || !canonical_child_of(container, workspace) ||
      !canonical_child_of(runtime_root, executable)) {
    fail(control, "path_boundary_failed");
    close(input);
    close(output);
    close(error_output);
    close(control);
    return;
  }
  if (!self_has_required_entitlements() || !helper_has_required_signature(executable)) {
    fail(control, "entitlement_chain_failed");
    close(input);
    close(output);
    close(error_output);
    close(control);
    return;
  }

  size_t count = xpc_array_get_count(arguments);
  if (count == 0 || count > 64) {
    fail(control, "invalid_arguments");
    close(input);
    close(output);
    close(error_output);
    close(control);
    return;
  }
  char **argv = calloc(count + 1, sizeof(char *));
  if (argv == NULL) {
    fail(control, "allocation_failed");
    close(input);
    close(output);
    close(error_output);
    close(control);
    return;
  }
  for (size_t index = 0; index < count; index += 1) {
    const char *value = xpc_array_get_string(arguments, index);
    if (value == NULL) {
      free(argv);
      fail(control, "invalid_arguments");
      close(input);
      close(output);
      close(error_output);
      close(control);
      return;
    }
    argv[index] = (char *)value;
  }

  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  bool actions_ready = posix_spawn_file_actions_init(&actions) == 0;
  bool attributes_ready = posix_spawnattr_init(&attributes) == 0;
  int setup_result = actions_ready && attributes_ready ? 0 : EINVAL;
  if (setup_result == 0) setup_result = posix_spawn_file_actions_adddup2(&actions, input, STDIN_FILENO);
  if (setup_result == 0) setup_result = posix_spawn_file_actions_adddup2(&actions, output, STDOUT_FILENO);
  if (setup_result == 0) setup_result = posix_spawn_file_actions_adddup2(&actions, error_output, STDERR_FILENO);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  if (setup_result == 0) setup_result = posix_spawn_file_actions_addchdir_np(&actions, workspace);
#pragma clang diagnostic pop
  if (setup_result == 0) {
    setup_result = posix_spawnattr_setflags(
        &attributes, POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT);
  }
  if (setup_result == 0) setup_result = posix_spawnattr_setpgroup(&attributes, 0);
  char home[PATH_MAX + 6];
  char temporary[PATH_MAX + 16];
  if (snprintf(home, sizeof(home), "HOME=%s", workspace) >= (int)sizeof(home) ||
      snprintf(temporary, sizeof(temporary), "TMPDIR=%s/tmp", workspace) >=
          (int)sizeof(temporary)) {
    setup_result = ENAMETOOLONG;
  }
  char *environment[] = {home, temporary, "PATH=", "PYTHONNOUSERSITE=1", NULL};
  pid_t child = 0;
  int result = setup_result == 0
      ? posix_spawn(&child, executable, &actions, &attributes, argv, environment)
      : setup_result;
  if (attributes_ready) posix_spawnattr_destroy(&attributes);
  if (actions_ready) posix_spawn_file_actions_destroy(&actions);
  close(input);
  close(output);
  close(error_output);
  free(argv);
  if (result != 0) {
    fail(control, "contained_spawn_failed");
    close(control);
    return;
  }

  session_t *session = calloc(1, sizeof(session_t));
  if (session == NULL) {
    kill(-child, SIGKILL);
    while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
    fail(control, "allocation_failed");
    close(control);
    return;
  }
  session->child = child;
  session->peer = xpc_retain(peer);
  xpc_connection_set_context(peer, session);
  dprintf(control,
      "{\"appSandbox\":true,\"backend\":\"macos-xpc-app-sandbox\","
      "\"helperInheritance\":true,\"networkClient\":false,\"networkServer\":false}\n");
  close(control);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    int status = 0;
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    dispatch_async(dispatch_get_main_queue(), ^{
      if (xpc_connection_get_context(session->peer) == session) {
        xpc_connection_set_context(session->peer, NULL);
        xpc_object_t reply = xpc_dictionary_create(NULL, NULL, 0);
        xpc_dictionary_set_string(reply, "operation", "exit");
        xpc_dictionary_set_int64(reply, "code", WIFEXITED(status) ? WEXITSTATUS(status) : 128);
        xpc_connection_send_message(session->peer, reply);
        xpc_release(reply);
      }
      xpc_release(session->peer);
      free(session);
    });
  });
}

static void handle_message(xpc_connection_t peer, xpc_object_t message) {
  const char *operation = xpc_dictionary_get_string(message, "operation");
  if (operation == NULL) return;
  if (strcmp(operation, "launch") == 0) {
    launch(peer, message);
    return;
  }
  if (strcmp(operation, "cancel") == 0) {
    session_t *session = xpc_connection_get_context(peer);
    if (session != NULL && session->child > 0) kill(-session->child, SIGKILL);
  }
}

static void accept_peer(xpc_connection_t peer) {
  xpc_connection_set_event_handler(peer, ^(xpc_object_t event) {
    if (xpc_get_type(event) == XPC_TYPE_DICTIONARY) handle_message(peer, event);
    else if (event == XPC_ERROR_CONNECTION_INVALID) {
      session_t *session = xpc_connection_get_context(peer);
      if (session != NULL && session->child > 0) kill(-session->child, SIGKILL);
    }
  });
  xpc_connection_resume(peer);
}

int main(void) {
  xpc_main(accept_peer);
}
