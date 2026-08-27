#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <shlobj.h>
#include <sddl.h>
#include <userenv.h>
#include <io.h>

#include <filesystem>
#include <cstdio>
#include <exception>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
static HANDLE active_job = nullptr;
static SRWLOCK active_job_lock = SRWLOCK_INIT;

static BOOL WINAPI control_handler(DWORD) {
  AcquireSRWLockShared(&active_job_lock);
  if (active_job != nullptr) TerminateJobObject(active_job, 1);
  ReleaseSRWLockShared(&active_job_lock);
  return TRUE;
}

static void set_active_job(HANDLE job) {
  AcquireSRWLockExclusive(&active_job_lock);
  active_job = job;
  ReleaseSRWLockExclusive(&active_job_lock);
}

static void close_job(HANDLE job) {
  AcquireSRWLockExclusive(&active_job_lock);
  if (active_job == job) active_job = nullptr;
  CloseHandle(job);
  ReleaseSRWLockExclusive(&active_job_lock);
}

static void fail(const char* reason) {
  char message[256];
  int length = snprintf(message, sizeof(message), "{\"error\":\"%s\"}\n", reason);
  if (length > 0) _write(3, message, static_cast<unsigned int>(length));
}

static void fail_setup(const std::exception& error) {
  std::string reason = "containment_setup_failed_";
  for (const char character : std::string(error.what()).substr(0, 96)) {
    reason += (character >= 'a' && character <= 'z') ||
            (character >= '0' && character <= '9') || character == '-'
        ? character
        : '_';
  }
  fail(reason.c_str());
}

[[noreturn]] static void throw_last_error(const char* stage, DWORD error) {
  throw std::runtime_error(std::string(stage) + "-" + std::to_string(error));
}

static void write_utf8_stdout(const std::wstring& value) {
  int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.c_str(),
      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) throw std::runtime_error("profile path encoding");
  std::string encoded(static_cast<size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.c_str(),
          static_cast<int>(value.size()), encoded.data(), size, nullptr, nullptr) != size) {
    throw std::runtime_error("profile path encoding");
  }
  encoded.push_back('\n');
  if (_write(STDOUT_FILENO, encoded.data(), static_cast<unsigned int>(encoded.size())) < 0) {
    throw std::runtime_error("profile path output");
  }
}

static bool valid_profile_name(const std::wstring& profile) {
  static constexpr wchar_t prefix[] = L"OpenChords.Analysis.";
  static constexpr size_t prefix_length = (sizeof(prefix) / sizeof(wchar_t)) - 1;
  static constexpr size_t uuid_length = 36;
  if (profile.rfind(prefix, 0) != 0 || profile.size() != prefix_length + uuid_length) return false;
  for (size_t index = 0; index < uuid_length; index += 1) {
    const wchar_t character = profile[prefix_length + index];
    const bool is_separator = index == 8 || index == 13 || index == 18 || index == 23;
    if (is_separator ? character != L'-' : !((character >= L'a' && character <= L'f') ||
                                                (character >= L'A' && character <= L'F') ||
                                                (character >= L'0' && character <= L'9'))) {
      return false;
    }
  }
  return true;
}

static fs::path local_app_data_root() {
  PWSTR local_app_data = nullptr;
  HRESULT result = SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr,
      &local_app_data);
  if (FAILED(result) || local_app_data == nullptr) throw std::runtime_error("local app data");
  fs::path root(local_app_data);
  CoTaskMemFree(local_app_data);
  return fs::canonical(root);
}

static fs::path runtime_staging_path(const std::wstring& profile) {
  if (!valid_profile_name(profile)) throw std::runtime_error("profile name");
  return local_app_data_root() / L"OpenChords" / L"ContainmentRuntime" / profile;
}

static fs::path create_runtime_staging_root(const std::wstring& profile) {
  const fs::path target = runtime_staging_path(profile);
  fs::path root = target.parent_path().parent_path().parent_path();
  for (const fs::path& component : {fs::path(L"OpenChords"),
           fs::path(L"ContainmentRuntime"), fs::path(profile)}) {
    root /= component;
    fs::create_directory(root);
    if ((GetFileAttributesW(root.c_str()) & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      throw std::runtime_error("runtime staging reparse");
    }
  }
  return fs::canonical(root);
}

static std::wstring windows_directory() {
  std::vector<wchar_t> buffer(MAX_PATH);
  UINT size = GetWindowsDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
  if (size == 0) throw std::runtime_error("windows directory");
  if (size >= buffer.size()) {
    buffer.resize(static_cast<size_t>(size) + 1);
    size = GetWindowsDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
    if (size == 0 || size >= buffer.size()) throw std::runtime_error("windows directory");
  }
  return std::wstring(buffer.data(), size);
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

static fs::path existing_runtime_staging_root(const std::wstring& profile) {
  const fs::path expected = runtime_staging_path(profile);
  fs::path root = expected.parent_path().parent_path().parent_path();
  for (const fs::path& component : {fs::path(L"OpenChords"),
           fs::path(L"ContainmentRuntime"), fs::path(profile)}) {
    root /= component;
    const DWORD attributes = GetFileAttributesW(root.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      throw std::runtime_error("runtime staging ancestor");
    }
  }
  reject_reparse_points(root);
  const fs::path canonical_root = fs::canonical(root);
  if (canonical_root != expected) throw std::runtime_error("runtime staging path");
  return canonical_root;
}

static bool remove_runtime_staging_root(const std::wstring& profile) noexcept {
  try {
    const fs::path expected = runtime_staging_path(profile);
    fs::path root = expected.parent_path().parent_path().parent_path();
    for (const fs::path& component : {fs::path(L"OpenChords"),
             fs::path(L"ContainmentRuntime"), fs::path(profile)}) {
      root /= component;
      const DWORD attributes = GetFileAttributesW(root.c_str());
      if (attributes == INVALID_FILE_ATTRIBUTES) {
        const DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
      }
      if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;
    }
    reject_reparse_points(root);
    if (fs::canonical(root) != expected) return false;
    fs::remove_all(root);
    return fs::symlink_status(root).type() == fs::file_type::not_found;
  } catch (...) {
    return false;
  }
}

static void grant_path_read_execute(
    const fs::path& path, PSID app_container_sid, DWORD inheritance) {
  PACL current_dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD result = GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION, nullptr, nullptr, &current_dacl, nullptr, &descriptor);
  if (result != ERROR_SUCCESS) throw_last_error("read runtime dacl", result);

  EXPLICIT_ACCESSW grant{};
  grant.grfAccessPermissions = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
  grant.grfAccessMode = SET_ACCESS;
  grant.grfInheritance = inheritance;
  grant.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  grant.Trustee.TrusteeType = TRUSTEE_IS_USER;
  grant.Trustee.ptstrName = static_cast<LPWSTR>(app_container_sid);
  PACL updated_dacl = nullptr;
  result = SetEntriesInAclW(1, &grant, current_dacl, &updated_dacl);
  if (result == ERROR_SUCCESS) {
    result = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, updated_dacl, nullptr);
  }
  if (updated_dacl != nullptr) LocalFree(updated_dacl);
  LocalFree(descriptor);
  if (result != ERROR_SUCCESS) throw_last_error("grant runtime access", result);
}

static void grant_runtime_read_execute(const fs::path& runtime_root, PSID app_container_sid) {
  grant_path_read_execute(
      runtime_root, app_container_sid, SUB_CONTAINERS_AND_OBJECTS_INHERIT);
  for (const auto& entry : fs::recursive_directory_iterator(runtime_root)) {
    grant_path_read_execute(entry.path(), app_container_sid,
        entry.is_directory() ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE);
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

static bool terminate_and_wait_for_empty_job(HANDLE job) {
  if (!TerminateJobObject(job, 1)) return false;
  ULONGLONG deadline = GetTickCount64() + 5000;
  while (true) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(
            job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) {
      return false;
    }
    if (accounting.ActiveProcesses == 0) return true;
    if (GetTickCount64() >= deadline) return false;
    Sleep(10);
  }
}

static int prepare(const std::wstring& profile) {
  if (!valid_profile_name(profile)) throw std::runtime_error("profile name");
  PSID sid = nullptr;
  HRESULT result = CreateAppContainerProfile(
      profile.c_str(), L"Open Chords Analysis", L"Ephemeral offline analysis", nullptr, 0, &sid);
  if (result == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
    throw std::runtime_error("profile already exists");
  }
  if (FAILED(result)) throw std::runtime_error("create profile");
  fs::path runtime_root;
  try {
    runtime_root = create_runtime_staging_root(profile);
    write_utf8_stdout(profile_root(sid));
    write_utf8_stdout(local_app_data_root().wstring());
    write_utf8_stdout(runtime_root.wstring());
  } catch (...) {
    const std::exception_ptr failure = std::current_exception();
    FreeSid(sid);
    const HRESULT delete_result = DeleteAppContainerProfile(profile.c_str());
    const bool profile_removed = SUCCEEDED(delete_result) ||
        delete_result == HRESULT_FROM_WIN32(ERROR_NOT_FOUND) ||
        delete_result == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
    const bool runtime_removed = remove_runtime_staging_root(profile);
    if (!profile_removed || !runtime_removed) throw std::runtime_error("prepare cleanup");
    std::rethrow_exception(failure);
  }
  FreeSid(sid);
  return 0;
}

static int launch(int argc, wchar_t** argv, const std::wstring& profile) {
  if (!valid_profile_name(profile)) throw std::runtime_error("profile name");
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
  fs::path expected_runtime_root = existing_runtime_staging_root(profile);
  fs::path executable = fs::canonical(argv[separator + 1]);
  if (!is_strict_child(root, workspace) ||
      fs::canonical(runtime_root) != expected_runtime_root ||
      !is_strict_child(runtime_root, executable)) {
    FreeSid(sid);
    throw std::runtime_error("path escaped profile");
  }
  reject_reparse_points(workspace);
  reject_reparse_points(runtime_root);
  grant_runtime_read_execute(runtime_root, sid);

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) throw std::runtime_error("create job");
  set_active_job(job);
  SetConsoleCtrlHandler(control_handler, TRUE);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
  limits.BasicLimitInformation.ActiveProcessLimit = 8;
  limits.ProcessMemoryLimit = 2ULL * 1024 * 1024 * 1024;
  limits.JobMemoryLimit = 3ULL * 1024 * 1024 * 1024;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    close_job(job); FreeSid(sid); throw std::runtime_error("job limits");
  }

  SECURITY_CAPABILITIES capabilities{};
  capabilities.AppContainerSid = sid;
  SIZE_T attribute_size = 0;
  InitializeProcThreadAttributeList(nullptr, 3, 0, &attribute_size);
  auto attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
      HeapAlloc(GetProcessHeap(), 0, attribute_size));
  if (attributes == nullptr) {
    close_job(job); FreeSid(sid); throw std::runtime_error("security capabilities allocation");
  }
  if (!InitializeProcThreadAttributeList(attributes, 3, 0, &attribute_size)) {
    HeapFree(GetProcessHeap(), 0, attributes);
    close_job(job); FreeSid(sid); throw std::runtime_error("security capabilities");
  }
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
          &capabilities, sizeof(capabilities), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
    close_job(job); FreeSid(sid); throw std::runtime_error("security capabilities");
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  startup.lpAttributeList = attributes;
  if (!SetHandleInformation(
          startup.StartupInfo.hStdInput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ||
      !SetHandleInformation(
          startup.StartupInfo.hStdOutput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ||
      !SetHandleInformation(
          startup.StartupInfo.hStdError, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
    close_job(job);
    FreeSid(sid);
    throw std::runtime_error("protocol handle inheritance");
  }
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
    close_job(job);
    FreeSid(sid);
    throw std::runtime_error("handle allowlist");
  }
  HANDLE job_list[] = {job};
  if (!UpdateProcThreadAttribute(
          attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, job_list,
          sizeof(job_list), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
    close_job(job);
    FreeSid(sid);
    throw std::runtime_error("job allowlist");
  }
  std::wstring command;
  for (int index = separator + 1; index < argc; index += 1) {
    if (!command.empty()) command += L" ";
    command += quote(argv[index]);
  }
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  std::wstring environment;
  const auto append_variable = [&environment](const std::wstring& entry) {
    environment.append(entry);
    environment.push_back(L'\0');
  };
  append_variable(L"APPDATA=" + workspace);
  append_variable(L"HOME=" + workspace);
  append_variable(L"LOCALAPPDATA=" + workspace);
  append_variable(L"PATH=");
  append_variable(L"SystemRoot=" + windows_directory());
  append_variable(L"TEMP=" + workspace);
  append_variable(L"TMP=" + workspace);
  append_variable(L"USERPROFILE=" + workspace);
  environment.push_back(L'\0');
  PROCESS_INFORMATION process{};
  bool created = CreateProcessW(executable.c_str(), mutable_command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
          EXTENDED_STARTUPINFO_PRESENT,
      environment.data(), workspace.c_str(), &startup.StartupInfo, &process);
  DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
  DeleteProcThreadAttributeList(attributes);
  HeapFree(GetProcessHeap(), 0, attributes);
  if (!created) {
    close_job(job);
    FreeSid(sid);
    throw_last_error("create contained process", create_error);
  }
  BOOL in_job = FALSE;
  if (!IsProcessInJob(process.hProcess, job, &in_job) || !in_job ||
      !verify_token(process.hProcess, sid)) {
    TerminateJobObject(job, 1); close_job(job); FreeSid(sid);
    throw std::runtime_error("verify process domain");
  }
  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    TerminateJobObject(job, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    close_job(job);
    FreeSid(sid);
    throw std::runtime_error("resume contained process");
  }
  static constexpr char evidence[] =
      "{\"appContainer\":true,\"backend\":\"windows-appcontainer-job\","
      "\"breakawayDisabled\":true,\"jobObject\":true,\"networkCapabilityCount\":0}\n";
  if (_write(3, evidence, sizeof(evidence) - 1) != sizeof(evidence) - 1) {
    TerminateJobObject(job, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    close_job(job);
    FreeSid(sid);
    throw std::runtime_error("containment evidence output");
  }
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 1;
  GetExitCodeProcess(process.hProcess, &exit_code);
  bool job_drained = terminate_and_wait_for_empty_job(job);
  CloseHandle(process.hProcess);
  close_job(job);
  FreeSid(sid);
  if (!job_drained) throw std::runtime_error("job did not drain");
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
    if (destroy) {
      if (!valid_profile_name(profile)) throw std::runtime_error("profile name");
      HRESULT result = DeleteAppContainerProfile(profile.c_str());
      const bool profile_removed = SUCCEEDED(result) ||
          result == HRESULT_FROM_WIN32(ERROR_NOT_FOUND) ||
          result == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
      const bool runtime_removed = remove_runtime_staging_root(profile);
      return profile_removed && runtime_removed ? 0 : 1;
    }
    if (profile.empty()) throw std::runtime_error("profile missing");
    return launch(argc, argv, profile);
  } catch (const std::exception& error) {
    fail_setup(error);
    return 70;
  } catch (...) {
    fail("containment_setup_failed_unknown");
    return 70;
  }
}
