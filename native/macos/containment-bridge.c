#include <dispatch/dispatch.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <xpc/xpc.h>

static xpc_connection_t connection;

static void send_cancel(void) {
  if (connection == NULL) return;
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, "operation", "cancel");
  xpc_connection_send_message(connection, message);
  xpc_release(message);
}

static void install_signal_source(int signal_number) {
  signal(signal_number, SIG_IGN);
  dispatch_source_t source = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)signal_number, 0, dispatch_get_main_queue());
  dispatch_source_set_event_handler(source, ^{ send_cancel(); });
  dispatch_resume(source);
}

int main(int argc, char **argv) {
  const char *workspace = NULL;
  const char *runtime_root = NULL;
  int separator = -1;
  for (int index = 1; index < argc; index += 1) {
    if (strncmp(argv[index], "--workspace=", 12) == 0) workspace = argv[index] + 12;
    else if (strncmp(argv[index], "--runtime-root=", 15) == 0) runtime_root = argv[index] + 15;
    else if (strcmp(argv[index], "--") == 0) {
      separator = index;
      break;
    }
  }
  if (workspace == NULL || runtime_root == NULL || separator < 0 || separator + 1 >= argc) {
    dprintf(3, "{\"error\":\"invalid_launch_plan\"}\n");
    return 64;
  }

  connection = xpc_connection_create(
      "io.github.qisoft.open-chords.analysis-service", dispatch_get_main_queue());
  if (connection == NULL) {
    dprintf(3, "{\"error\":\"xpc_service_unavailable\"}\n");
    return 70;
  }
  xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
    if (xpc_get_type(event) == XPC_TYPE_ERROR) {
      dprintf(3, "{\"error\":\"xpc_connection_failed\"}\n");
      exit(70);
    }
    if (xpc_get_type(event) != XPC_TYPE_DICTIONARY) return;
    const char *operation = xpc_dictionary_get_string(event, "operation");
    if (operation != NULL && strcmp(operation, "exit") == 0) {
      exit((int)xpc_dictionary_get_int64(event, "code"));
    }
  });
  xpc_connection_resume(connection);

  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, "operation", "launch");
  xpc_dictionary_set_string(message, "workspace", workspace);
  xpc_dictionary_set_string(message, "runtime_root", runtime_root);
  xpc_dictionary_set_string(message, "executable", argv[separator + 1]);
  xpc_dictionary_set_fd(message, "stdin", STDIN_FILENO);
  xpc_dictionary_set_fd(message, "stdout", STDOUT_FILENO);
  xpc_dictionary_set_fd(message, "stderr", STDERR_FILENO);
  xpc_dictionary_set_fd(message, "control", 3);
  xpc_object_t arguments = xpc_array_create(NULL, 0);
  for (int index = separator + 1; index < argc; index += 1) {
    xpc_array_set_string(arguments, XPC_ARRAY_APPEND, argv[index]);
  }
  xpc_dictionary_set_value(message, "arguments", arguments);
  xpc_release(arguments);
  xpc_connection_send_message(connection, message);
  xpc_release(message);

  install_signal_source(SIGINT);
  install_signal_source(SIGTERM);
  dispatch_main();
}
