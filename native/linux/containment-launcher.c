#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <limits.h>
#include <netinet/in.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static void fail(const char *reason) {
  dprintf(STDERR_FILENO, "OC_CONTAINMENT_V1 {\"error\":\"%s\"}\n", reason);
}

static int read_text(const char *path, char *buffer, size_t size) {
  int descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) return -1;
  ssize_t length = read(descriptor, buffer, size - 1);
  close(descriptor);
  if (length < 0) return -1;
  buffer[length] = '\0';
  return 0;
}

static int bounded_limit(const char *value, unsigned long long maximum) {
  if (strcmp(value, "max\n") == 0 || strcmp(value, "max") == 0) return -1;
  errno = 0;
  char *end = NULL;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || (*end != '\n' && *end != '\0') || parsed > maximum) {
    return -1;
  }
  return 0;
}

static int verify_systemd_scope(const char *expected_unit) {
  char membership[4096];
  if (read_text("/proc/self/cgroup", membership, sizeof(membership)) < 0) return -1;
  char *unified = strstr(membership, "0::/");
  if (unified == NULL) return -1;
  unified += 3;
  char *newline = strchr(unified, '\n');
  if (newline != NULL) *newline = '\0';
  const char *basename = strrchr(unified, '/');
  basename = basename == NULL ? unified : basename + 1;
  if (strcmp(basename, expected_unit) != 0 || strstr(unified, "..") != NULL) return -1;
  char root[8192];
  if (snprintf(root, sizeof(root), "/sys/fs/cgroup/%s", unified) >= (int)sizeof(root)) return -1;
  char path[8192];
  char value[256];
  if (snprintf(path, sizeof(path), "%s/pids.max", root) >= (int)sizeof(path) ||
      read_text(path, value, sizeof(value)) < 0 || bounded_limit(value, 8) < 0) return -1;
  if (snprintf(path, sizeof(path), "%s/memory.max", root) >= (int)sizeof(path) ||
      read_text(path, value, sizeof(value)) < 0 ||
      bounded_limit(value, 3221225472ULL) < 0) return -1;
  if (snprintf(path, sizeof(path), "%s/cgroup.procs", root) >= (int)sizeof(path) ||
      read_text(path, value, sizeof(value)) < 0) return -1;
  char *cursor = value;
  while (*cursor != '\0') {
    char *end = NULL;
    long member = strtol(cursor, &end, 10);
    if (end != cursor && member == (long)getpid()) return 0;
    cursor = strchr(cursor, '\n');
    if (cursor == NULL) break;
    cursor += 1;
  }
  return -1;
}

static int add_landlock_path(int ruleset, const char *path, __u64 access) {
  int parent = open(path, O_PATH | O_CLOEXEC | O_NOFOLLOW);
  if (parent < 0) return -1;
  struct landlock_path_beneath_attr rule = {.allowed_access = access, .parent_fd = parent};
  int result = syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  close(parent);
  return result;
}

static int apply_landlock(const char *runtime_root, const char *workspace) {
  int abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) return -1;
  __u64 read_execute = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
      LANDLOCK_ACCESS_FS_READ_DIR;
  __u64 handled = read_execute | LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
      LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
      LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
      LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
      LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER |
      LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_ruleset_attr ruleset = {.handled_access_fs = handled};
  int descriptor = syscall(__NR_landlock_create_ruleset, &ruleset, sizeof(ruleset), 0);
  if (descriptor < 0) return -1;
  const char *system_roots[] = {"/lib", "/lib64", "/usr/lib", "/usr/lib64"};
  if (add_landlock_path(descriptor, runtime_root, read_execute) < 0 ||
      add_landlock_path(descriptor, workspace, handled) < 0) {
    close(descriptor);
    return -1;
  }
  for (size_t index = 0; index < sizeof(system_roots) / sizeof(system_roots[0]); index += 1) {
    char canonical[PATH_MAX];
    if (realpath(system_roots[index], canonical) != NULL &&
        add_landlock_path(descriptor, canonical, read_execute) < 0) {
      close(descriptor);
      return -1;
    }
  }
  if (access("/etc/ld.so.cache", F_OK) == 0 &&
      add_landlock_path(descriptor, "/etc/ld.so.cache", LANDLOCK_ACCESS_FS_READ_FILE) < 0) {
    close(descriptor);
    return -1;
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 ||
      syscall(__NR_landlock_restrict_self, descriptor, 0) < 0) {
    close(descriptor);
    return -1;
  }
  close(descriptor);
  return abi;
}

static int apply_seccomp(void) {
#if defined(__x86_64__)
  const uint32_t expected_arch = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
  const uint32_t expected_arch = AUDIT_ARCH_AARCH64;
#else
#error Unsupported Linux Preview architecture
#endif
  struct sock_filter filter[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, expected_arch, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef __NR_io_uring_setup
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
#endif
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 3),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {
      .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])), .filter = filter};
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

int main(int argc, char **argv) {
  const char *workspace = NULL;
  const char *runtime_root = NULL;
  const char *expected_unit = NULL;
  int separator = -1;
  for (int index = 1; index < argc; index += 1) {
    if (strncmp(argv[index], "--workspace=", 12) == 0) workspace = argv[index] + 12;
    else if (strncmp(argv[index], "--runtime-root=", 15) == 0) runtime_root = argv[index] + 15;
    else if (strncmp(argv[index], "--expected-unit=", 16) == 0) expected_unit = argv[index] + 16;
    else if (strcmp(argv[index], "--") == 0) { separator = index; break; }
  }
  if (workspace == NULL || runtime_root == NULL || expected_unit == NULL ||
      separator < 0 || separator + 1 >= argc) {
    fail("invalid_launch_plan");
    return 64;
  }
  if (verify_systemd_scope(expected_unit) < 0) {
    fail("cgroup_scope_unverified");
    return 70;
  }
  char canonical_runtime[PATH_MAX];
  char canonical_workspace[PATH_MAX];
  char canonical_executable[PATH_MAX];
  if (realpath(runtime_root, canonical_runtime) == NULL ||
      realpath(workspace, canonical_workspace) == NULL ||
      realpath(argv[separator + 1], canonical_executable) == NULL) {
    fail("path_boundary_failed");
    return 70;
  }
  size_t runtime_length = strlen(canonical_runtime);
  if (strncmp(canonical_runtime, canonical_executable, runtime_length) != 0 ||
      canonical_executable[runtime_length] != '/') {
    fail("path_boundary_failed");
    return 70;
  }
  int abi = apply_landlock(canonical_runtime, canonical_workspace);
  if (abi < 3 || apply_seccomp() < 0 || chdir(canonical_workspace) < 0) {
    fail("containment_setup_failed");
    return 70;
  }
  dprintf(STDERR_FILENO,
      "OC_CONTAINMENT_V1 {\"backend\":\"linux-landlock-seccomp\","
      "\"cgroupDelegated\":true,\"landlockAbi\":%d,"
      "\"noNewPrivileges\":true,\"seccompFilter\":true}\n", abi);
  char home[8192];
  char temporary[8192];
  snprintf(home, sizeof(home), "HOME=%s", canonical_workspace);
  snprintf(temporary, sizeof(temporary), "TMPDIR=%s", canonical_workspace);
  char *environment[] = {home, temporary, (char *)"PATH=", (char *)"PYTHONNOUSERSITE=1", NULL};
  execve(canonical_executable, &argv[separator + 1], environment);
  return 70;
}
