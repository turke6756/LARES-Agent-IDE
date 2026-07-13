// lares-native (Windows) — Job Object process ownership + system commit telemetry.
//
// Exposes exactly the surface the incident-remediation plan (§5 step 0) calls for:
//   createNamedJob(name)  -> JobHandle   (no KILL_ON_JOB_CLOSE; breakaway denied)
//   openNamedJob(name)    -> JobHandle | null
//   assignPid(job, pid)   -> boolean
//   listJobPids(job)      -> number[]
//   terminateJob(job)     -> boolean
//   pidCreationTime(pid)  -> string | null   (FILETIME as decimal string)
//   getCommitStatus()     -> { commitLimitBytes, commitAvailableBytes, ... }
//
// Written against the C N-API (node_api.h) so it carries no node-addon-api / nan
// dependency — in-family with the raw-N-API style of the repo's other native builds.
// Named jobs use the convention: Local\Lares.agent.<agentId>.<instanceEpoch>.

#include <node_api.h>
#include <windows.h>
#include <string>
#include <vector>

namespace {

// ── error helpers ──────────────────────────────────────────────────────────
void throw_win32(napi_env env, const char* fn, DWORD err) {
  char msg[256];
  _snprintf_s(msg, sizeof(msg), _TRUNCATE, "%s failed (GetLastError=%lu)", fn, err);
  napi_throw_error(env, nullptr, msg);
}

// A Job Object handle wrapped for JS. CloseHandle on GC — closing a handle does
// NOT terminate the job (KILL_ON_JOB_CLOSE is deliberately unset), so dropping
// the JS wrapper is safe: the named job survives as long as a member runs.
struct JobHandle {
  HANDLE h;
};

void job_finalize(napi_env /*env*/, void* data, void* /*hint*/) {
  JobHandle* jh = static_cast<JobHandle*>(data);
  if (jh) {
    if (jh->h) CloseHandle(jh->h);
    delete jh;
  }
}

napi_value wrap_job(napi_env env, HANDLE h) {
  JobHandle* jh = new JobHandle{h};
  napi_value ext;
  napi_status s = napi_create_external(env, jh, job_finalize, nullptr, &ext);
  if (s != napi_ok) {
    CloseHandle(h);
    delete jh;
    napi_throw_error(env, nullptr, "napi_create_external failed");
    return nullptr;
  }
  return ext;
}

bool unwrap_job(napi_env env, napi_value v, HANDLE* out) {
  void* data = nullptr;
  if (napi_get_value_external(env, v, &data) != napi_ok || data == nullptr) {
    napi_throw_type_error(env, nullptr, "expected a JobHandle (external) argument");
    return false;
  }
  *out = static_cast<JobHandle*>(data)->h;
  return true;
}

// Read a JS string argument as a wide (UTF-16) Windows string.
bool arg_to_wstring(napi_env env, napi_value v, std::wstring* out) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &len) != napi_ok) {
    napi_throw_type_error(env, nullptr, "expected a string argument");
    return false;
  }
  std::string utf8(len, '\0');
  size_t written = 0;
  napi_get_value_string_utf8(env, v, &utf8[0], len + 1, &written);
  int wlen = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)written, nullptr, 0);
  out->assign(wlen, L'\0');
  if (wlen) MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)written, &(*out)[0], wlen);
  return true;
}

bool arg_to_uint32(napi_env env, napi_value v, uint32_t* out) {
  if (napi_get_value_uint32(env, v, out) != napi_ok) {
    napi_throw_type_error(env, nullptr, "expected a PID (uint32) argument");
    return false;
  }
  return true;
}

// Apply the intended limit policy to a freshly created job:
//   - LimitFlags = 0  => NO JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (drain survival)
//   - JOB_OBJECT_LIMIT_BREAKAWAY_OK NOT set => breakaway denied, so a child that
//     requests CREATE_BREAKAWAY_FROM_JOB is refused and descendants stay in the job.
bool apply_job_policy(HANDLE job) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
  ZeroMemory(&info, sizeof(info));
  info.BasicLimitInformation.LimitFlags = 0;
  return SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                 &info, sizeof(info)) != 0;
}

// ── exported functions ─────────────────────────────────────────────────────

napi_value CreateNamedJob(napi_env env, napi_callback_info cbi) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, cbi, &argc, argv, nullptr, nullptr);
  if (argc < 1) { napi_throw_type_error(env, nullptr, "createNamedJob(name) requires a name"); return nullptr; }

  std::wstring name;
  if (!arg_to_wstring(env, argv[0], &name)) return nullptr;

  // Named object; CreateJobObjectW returns an existing job (ERROR_ALREADY_EXISTS)
  // idempotently, which is fine for reconcile flows.
  HANDLE job = CreateJobObjectW(nullptr, name.c_str());
  if (!job) { throw_win32(env, "CreateJobObjectW", GetLastError()); return nullptr; }

  if (!apply_job_policy(job)) {
    DWORD err = GetLastError();
    CloseHandle(job);
    throw_win32(env, "SetInformationJobObject", err);
    return nullptr;
  }
  return wrap_job(env, job);
}

napi_value OpenNamedJob(napi_env env, napi_callback_info cbi) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, cbi, &argc, argv, nullptr, nullptr);
  if (argc < 1) { napi_throw_type_error(env, nullptr, "openNamedJob(name) requires a name"); return nullptr; }

  std::wstring name;
  if (!arg_to_wstring(env, argv[0], &name)) return nullptr;

  HANDLE job = OpenJobObjectW(JOB_OBJECT_ALL_ACCESS, FALSE, name.c_str());
  if (!job) {
    DWORD err = GetLastError();
    if (err == ERROR_FILE_NOT_FOUND) {
      // No such named job (no live members) — a normal "not found", return null.
      napi_value nul;
      napi_get_null(env, &nul);
      return nul;
    }
    throw_win32(env, "OpenJobObjectW", err);
    return nullptr;
  }
  return wrap_job(env, job);
}

napi_value AssignPid(napi_env env, napi_callback_info cbi) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, cbi, &argc, argv, nullptr, nullptr);
  if (argc < 2) { napi_throw_type_error(env, nullptr, "assignPid(job, pid) requires two arguments"); return nullptr; }

  HANDLE job;
  if (!unwrap_job(env, argv[0], &job)) return nullptr;
  uint32_t pid;
  if (!arg_to_uint32(env, argv[1], &pid)) return nullptr;

  HANDLE proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid);
  if (!proc) { throw_win32(env, "OpenProcess(assign)", GetLastError()); return nullptr; }

  BOOL ok = AssignProcessToJobObject(job, proc);
  DWORD err = ok ? 0 : GetLastError();
  CloseHandle(proc);
  if (!ok) { throw_win32(env, "AssignProcessToJobObject", err); return nullptr; }

  napi_value res;
  napi_get_boolean(env, true, &res);
  return res;
}

napi_value ListJobPids(napi_env env, napi_callback_info cbi) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, cbi, &argc, argv, nullptr, nullptr);
  if (argc < 1) { napi_throw_type_error(env, nullptr, "listJobPids(job) requires a job"); return nullptr; }

  HANDLE job;
  if (!unwrap_job(env, argv[0], &job)) return nullptr;

  DWORD capacity = 256;
  std::vector<BYTE> buf;
  JOBOBJECT_BASIC_PROCESS_ID_LIST* list = nullptr;
  for (int attempt = 0; attempt < 8; ++attempt) {
    size_t bytes = sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) +
                   (capacity - 1) * sizeof(ULONG_PTR);
    buf.assign(bytes, 0);
    list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buf.data());
    if (QueryInformationJobObject(job, JobObjectBasicProcessIdList,
                                  list, (DWORD)bytes, nullptr)) {
      break;
    }
    DWORD err = GetLastError();
    if (err == ERROR_MORE_DATA) {
      capacity *= 4;  // grow and retry
      list = nullptr;
      continue;
    }
    throw_win32(env, "QueryInformationJobObject", err);
    return nullptr;
  }
  if (!list) { napi_throw_error(env, nullptr, "listJobPids: too many processes in job"); return nullptr; }

  napi_value arr;
  napi_create_array_with_length(env, list->NumberOfProcessIdsInList, &arr);
  for (DWORD i = 0; i < list->NumberOfProcessIdsInList; ++i) {
    napi_value pidv;
    napi_create_uint32(env, (uint32_t)list->ProcessIdList[i], &pidv);
    napi_set_element(env, arr, i, pidv);
  }
  return arr;
}

napi_value TerminateJob(napi_env env, napi_callback_info cbi) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, cbi, &argc, argv, nullptr, nullptr);
  if (argc < 1) { napi_throw_type_error(env, nullptr, "terminateJob(job) requires a job"); return nullptr; }

  HANDLE job;
  if (!unwrap_job(env, argv[0], &job)) return nullptr;

  if (!TerminateJobObject(job, 1)) { throw_win32(env, "TerminateJobObject", GetLastError()); return nullptr; }

  napi_value res;
  napi_get_boolean(env, true, &res);
  return res;
}

napi_value PidCreationTime(napi_env env, napi_callback_info cbi) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, cbi, &argc, argv, nullptr, nullptr);
  if (argc < 1) { napi_throw_type_error(env, nullptr, "pidCreationTime(pid) requires a pid"); return nullptr; }

  uint32_t pid;
  if (!arg_to_uint32(env, argv[0], &pid)) return nullptr;

  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) {
    // Process gone or inaccessible — return null so callers treat it as "unknown".
    napi_value nul;
    napi_get_null(env, &nul);
    return nul;
  }
  FILETIME creation, exit, kernel, user;
  BOOL ok = GetProcessTimes(proc, &creation, &exit, &kernel, &user);
  CloseHandle(proc);
  if (!ok) {
    napi_value nul;
    napi_get_null(env, &nul);
    return nul;
  }
  ULONGLONG ft = ((ULONGLONG)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
  // FILETIME (100ns since 1601) exceeds 2^53, so return a decimal string, not a Number.
  char out[32];
  _snprintf_s(out, sizeof(out), _TRUNCATE, "%llu", ft);
  napi_value res;
  napi_create_string_utf8(env, out, NAPI_AUTO_LENGTH, &res);
  return res;
}

void set_num(napi_env env, napi_value obj, const char* key, double v) {
  napi_value nv;
  napi_create_double(env, v, &nv);
  napi_set_named_property(env, obj, key, nv);
}

napi_value GetCommitStatus(napi_env env, napi_callback_info /*cbi*/) {
  MEMORYSTATUSEX ms;
  ms.dwLength = sizeof(ms);
  if (!GlobalMemoryStatusEx(&ms)) { throw_win32(env, "GlobalMemoryStatusEx", GetLastError()); return nullptr; }

  napi_value obj;
  napi_create_object(env, &obj);
  // Commit = system-wide committed memory limit / available headroom (bytes).
  set_num(env, obj, "commitLimitBytes", (double)ms.ullTotalPageFile);
  set_num(env, obj, "commitAvailableBytes", (double)ms.ullAvailPageFile);
  set_num(env, obj, "commitChargeBytes", (double)(ms.ullTotalPageFile - ms.ullAvailPageFile));
  set_num(env, obj, "physicalTotalBytes", (double)ms.ullTotalPhys);
  set_num(env, obj, "physicalAvailableBytes", (double)ms.ullAvailPhys);
  set_num(env, obj, "memoryLoadPercent", (double)ms.dwMemoryLoad);
  return obj;
}

napi_value PlatformSupported(napi_env env, napi_callback_info /*cbi*/) {
  napi_value res;
  napi_get_boolean(env, true, &res);
  return res;
}

// ── init ────────────────────────────────────────────────────────────────────
napi_value Init(napi_env env, napi_value exports) {
  struct { const char* name; napi_callback fn; } entries[] = {
    {"createNamedJob", CreateNamedJob},
    {"openNamedJob", OpenNamedJob},
    {"assignPid", AssignPid},
    {"listJobPids", ListJobPids},
    {"terminateJob", TerminateJob},
    {"pidCreationTime", PidCreationTime},
    {"getCommitStatus", GetCommitStatus},
    {"platformSupported", PlatformSupported},
  };
  for (auto& e : entries) {
    napi_value fn;
    napi_create_function(env, e.name, NAPI_AUTO_LENGTH, e.fn, nullptr, &fn);
    napi_set_named_property(env, exports, e.name, fn);
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
