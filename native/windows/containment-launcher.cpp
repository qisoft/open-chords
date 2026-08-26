#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <userenv.h>
#include <io.h>

#include <filesystem>
#include <cstdio>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
static HANDLE active_job = nullptr;

static BOOL WINAPI control_handler(DWORD) {
  if (active_job != nullptr) TerminateJobObject(active_job, 1);
  return TRUE;
}

static void fail(const char* reason) {
  char message[256];
  int length = snprintf(message, sizeof(message), "{\"error\":\"%s\"}\n", reason);
  if (length > 0) _write(3, message, static_cast<unsigned int>(length));
}

static std::wstring value_after(const std::wstring& value, const wchar_t* prefix) {
  std::wstring expected(prefix);
  return value.rfind(expected, 0) == 0 ? value.substr(expected.size()) : L"";
}

static std::wstring profile_root(PSID sid) {
  LPWSTR sid_text = nullptr;
  if (!ConvertSidToStringSidW(sid, &sid_text)) throw std::runtime_error("sid string");
  PWSTR folder = nullptr;
  HRESULT result = GetAppContainerFolderPath(sid_text, &folder);
  LocalFree(sid_text);
  if (FAILED(result) || folder == nullptr) throw std::runtime_error("profile folder");
  std::wstring path(folder);
  CoTaskMemFree(folder);
  return path;
}

static PSID derive_profile(const std::wstring& profile) {
  PSID sid = nullptr;
  if (FAILED(DeriveAppContainerSidFromAppContainerName(profile.c_str(), &sid))) {
    throw std::runtime_error("derive profile");
  }
  return sid;
}

static bool is_strict_child(const fs::path& root, const fs::path& child) {
  fs::path relative = fs::relative(fs::canonical(child), fs::canonical(root));
  if (relative.empty() || relative.is_absolute()) return false;
  return *relative.begin() != L"..";
}

static void reject_reparse_points(const fs::path& root) {
  if ((GetFileAttributesW(root.c_str()) & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    throw std::runtime_error("reparse root");
  }
  for (const auto& entry : fs::recursive_directory_iterator(root)) {
    if (entry.is_symlink() ||
        (GetFileAttributesW(entry.path().c_str()) & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      throw std::runtime_error("reparse entry");
    }
  }
}

static std::wstring quote(const std::wstring& value) {
  if (value.find_first_of(L" \t\"") == std::wstring::npos) return value;
  std::wstring output = L"\"";
  size_t slashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') slashes += 1;
    else if (character == L'\"') {
      output.append(slashes * 2 + 1, L'\\');
      output += character;
      slashes = 0;
    } else {
      output.append(slashes, L'\\');
      output += character;
      slashes = 0;
    }
  }
  output.append(slashes * 2, L'\\');
  return output + L"\"";
}

static bool verify_token(HANDLE process, PSID expected) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return false;
  DWORD is_container = 0;
  DWORD size = 0;
  bool valid = GetTokenInformation(
      token, TokenIsAppContainer, &is_container, sizeof(is_container), &size) &&
      is_container != 0;
  GetTokenInformation(token, TokenAppContainerSid, nullptr, 0, &size);
  std::vector<unsigned char> buffer(size);
  if (valid && GetTokenInformation(token, TokenAppContainerSid, buffer.data(), size, &size)) {
    auto information = reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(buffer.data());
    valid = EqualSid(information->TokenAppContainer, expected);
  } else valid = false;
  CloseHandle(token);
  return valid;
}

static int prepare(const std::wstring& profile) {
  PSID sid = nullptr;
  HRESULT result = CreateAppContainerProfile(
      profile.c_str(), L"Open Chords Analysis", L"Ephemeral offline analysis", nullptr, 0, &sid);
  if (result == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) sid = derive_profile(profile);
  else if (FAILED(result)) throw std::runtime_error("create profile");
  std::wcout << profile_root(sid) << std::endl;
  FreeSid(sid);
  return 0;
}

static int launch(int argc, wchar_t** argv, const std::wstring& profile) {
  std::wstring workspace;
  std::wstring runtime_root;
  int separator = -1;
  for (int index = 1; index < argc; index += 1) {
    if (auto value = value_after(argv[index], L"--workspace="); !value.empty()) workspace = value;
    else if (auto value = value_after(argv[index], L"--runtime-root="); !value.empty()) runtime_root = value;
    else if (std::wstring(argv[index]) == L"--") { separator = index; break; }
  }
  if (workspace.empty() || runtime_root.empty() || separator < 0 || separator + 1 >= argc) {
    throw std::runtime_error("launch plan");
  }
  PSID sid = derive_profile(profile);
  fs::path root = profile_root(sid);
  fs::path executable = fs::canonical(argv[separator + 1]);
  if (!is_strict_child(root, workspace) || !is_strict_child(root, runtime_root) ||
      !is_strict_child(runtime_root, executable)) {
    FreeSid(sid);
    throw std::runtime_error("path escaped profile");
  }
  reject_reparse_points(workspace);
  reject_reparse_points(runtime_root);

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) throw std::runtime_error("create job");
  active_job = job;
  SetConsoleCtrlHandler(control_handler, TRUE);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
  limits.BasicLimitInformation.ActiveProcessLimit = 8;
  limits.ProcessMemoryLimit = 2ULL * 1024 * 1024 * 1024;
  limits.JobMemoryLimit = 3ULL * 1024 * 1024 * 1024;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    CloseHandle(job); FreeSid(sid); throw std::runtime_error("job limits");
  }

  SECURITY_CAPABILITIES capabilities{};
  capabilities.AppContainerSid = sid;
  SIZE_T attribute_size = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &attribute_size);
  auto attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
      HeapAlloc(GetProcessHeap(), 0, attribute_size));
  if (attributes == nullptr ||
      !InitializeProcThreadAttributeList(attributes, 2, 0, &attribute_size) ||
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
          &capabilities, sizeof(capabilities), nullptr, nullptr)) {
    CloseHandle(job); FreeSid(sid); throw std::runtime_error("security capabilities");
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  startup.lpAttributeList = attributes;
  SetHandleInformation(startup.StartupInfo.hStdInput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  SetHandleInformation(startup.StartupInfo.hStdOutput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  SetHandleInformation(startup.StartupInfo.hStdError, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  HANDLE inherited_handles[] = {
      startup.StartupInfo.hStdInput,
      startup.StartupInfo.hStdOutput,
      startup.StartupInfo.hStdError,
  };
  if (!UpdateProcThreadAttribute(
          attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited_handles,
          sizeof(inherited_handles), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
    CloseHandle(job);
    FreeSid(sid);
    throw std::runtime_error("handle allowlist");
  }
  std::wstring command;
  for (int index = separator + 1; index < argc; index += 1) {
    if (!command.empty()) command += L" ";
    command += quote(argv[index]);
  }
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  std::wstring environment = L"HOME=" + workspace + L"\0PATH=\0TEMP=" + workspace +
      L"\0TMP=" + workspace + L"\0\0";
  PROCESS_INFORMATION process{};
  bool created = CreateProcessW(executable.c_str(), mutable_command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
          EXTENDED_STARTUPINFO_PRESENT,
      environment.data(), workspace.c_str(), &startup.StartupInfo, &process);
  DeleteProcThreadAttributeList(attributes);
  HeapFree(GetProcessHeap(), 0, attributes);
  if (!created || !AssignProcessToJobObject(job, process.hProcess)) {
    if (created) TerminateProcess(process.hProcess, 1);
    CloseHandle(job); FreeSid(sid); throw std::runtime_error("contained process");
  }
  BOOL in_job = FALSE;
  if (!IsProcessInJob(process.hProcess, job, &in_job) || !in_job ||
      !verify_token(process.hProcess, sid)) {
    TerminateJobObject(job, 1); CloseHandle(job); FreeSid(sid);
    throw std::runtime_error("verify process domain");
  }
  static constexpr char evidence[] =
      "{\"appContainer\":true,\"backend\":\"windows-appcontainer-job\","
      "\"breakawayDisabled\":true,\"jobObject\":true,\"networkCapabilityCount\":0}\n";
  _write(3, evidence, sizeof(evidence) - 1);
  ResumeThread(process.hThread);
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 1;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hProcess);
  CloseHandle(job);
  active_job = nullptr;
  FreeSid(sid);
  return static_cast<int>(exit_code);
}

int wmain(int argc, wchar_t** argv) {
  try {
    std::wstring profile;
    bool destroy = false;
    for (int index = 1; index < argc; index += 1) {
      if (auto value = value_after(argv[index], L"--prepare="); !value.empty()) return prepare(value);
      if (auto value = value_after(argv[index], L"--destroy="); !value.empty()) {
        profile = value; destroy = true; break;
      }
      if (auto value = value_after(argv[index], L"--profile="); !value.empty()) profile = value;
    }
    if (destroy) return SUCCEEDED(DeleteAppContainerProfile(profile.c_str())) ? 0 : 1;
    if (profile.empty()) throw std::runtime_error("profile missing");
    return launch(argc, argv, profile);
  } catch (...) {
    fail("containment_setup_failed");
    return 70;
  }
}
