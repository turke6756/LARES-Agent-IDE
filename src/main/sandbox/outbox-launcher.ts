import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const NON_WINDOWS_OUTBOX_SKIP_MARKER = '[lares-outbox-sandbox:SKIP_NON_WINDOWS]';
export const OUTBOX_AUDIT_MARKER = '[lares-outbox-audit]';

export interface RestrictedOutboxLaunchOptions {
  command: string;
  args: string[];
  cwd: string;
  outbox: string;
  auditRoots?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface PreparedRestrictedOutboxLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  syntheticSid: string;
}

interface RestrictedOutboxLauncherDeps {
  platform?: NodeJS.Platform;
  powershellPath?: string;
  runPreflight?: (command: string, args: string[], env: NodeJS.ProcessEnv) => void;
  randomBytes?: (size: number) => Buffer;
}

const SPEC_ENV = 'LARES_RESTRICTED_OUTBOX_SPEC_B64';

// The bootstrap deliberately contains the Win32 calls rather than relying on a
// provider SDK. CreateRestrictedToken is available to an unelevated process; a
// restricted derivative of the caller's primary token may be passed to
// CreateProcessAsUser without the normally-required token privileges.
const POWERSHELL_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
$selfPath = $MyInvocation.MyCommand.Path
$specBytes = [Convert]::FromBase64String($env:${SPEC_ENV})
$spec = [Text.Encoding]::UTF8.GetString($specBytes) | ConvertFrom-Json

$nativeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class LaresRestrictedOutboxNative {
    const UInt32 TOKEN_ASSIGN_PRIMARY = 0x0001;
    const UInt32 TOKEN_DUPLICATE = 0x0002;
    const UInt32 TOKEN_QUERY = 0x0008;
    const UInt32 TOKEN_ADJUST_PRIVILEGES = 0x0020;
    const UInt32 TOKEN_ADJUST_DEFAULT = 0x0080;
    const UInt32 TOKEN_ADJUST_SESSIONID = 0x0100;
    const UInt32 DISABLE_MAX_PRIVILEGE = 0x0001;
    const UInt32 LUA_TOKEN = 0x0004;
    const UInt32 WRITE_RESTRICTED = 0x0008;
    const UInt32 INFINITE = 0xFFFFFFFF;
    const UInt32 SE_GROUP_LOGON_ID = 0xC0000000;
    const UInt32 GENERIC_ALL = 0x10000000;

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES { public IntPtr Sid; public UInt32 Attributes; }

    [StructLayout(LayoutKind.Sequential)] struct LUID { public UInt32 LowPart; public Int32 HighPart; }
    [StructLayout(LayoutKind.Sequential)] struct LUID_AND_ATTRIBUTES { public LUID Luid; public UInt32 Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_PRIVILEGES { public UInt32 PrivilegeCount; public LUID_AND_ATTRIBUTES Privileges; }
    [StructLayout(LayoutKind.Sequential)]
    struct TRUSTEE {
        public IntPtr pMultipleTrustee;
        public Int32 MultipleTrusteeOperation, TrusteeForm, TrusteeType;
        public IntPtr ptstrName;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct EXPLICIT_ACCESS {
        public UInt32 grfAccessPermissions;
        public Int32 grfAccessMode;
        public UInt32 grfInheritance;
        public TRUSTEE Trustee;
    }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_DEFAULT_DACL { public IntPtr DefaultDacl; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public UInt32 cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public UInt32 dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public UInt32 dwFillAttribute, dwFlags;
        public UInt16 wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public UInt32 dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool OpenProcessToken(IntPtr process, UInt32 access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool GetTokenInformation(IntPtr token, Int32 informationClass, IntPtr information,
        UInt32 informationLength, out UInt32 returnLength);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool CreateRestrictedToken(IntPtr existing, UInt32 flags, UInt32 disableCount,
        IntPtr disableSids, UInt32 deletePrivilegeCount, IntPtr deletePrivileges,
        UInt32 restrictedCount, [In] SID_AND_ATTRIBUTES[] restrictedSids, out IntPtr token);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ConvertStringSidToSid(string sid, out IntPtr sidPointer);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcessAsUser(IntPtr token, string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, UInt32 creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool LookupPrivilegeValue(string systemName, string name, out LUID luid);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TOKEN_PRIVILEGES newState,
        UInt32 bufferLength, IntPtr previousState, IntPtr returnLength);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern UInt32 SetEntriesInAcl(UInt32 count, [In] EXPLICIT_ACCESS[] entries, IntPtr oldAcl, out IntPtr newAcl);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool SetTokenInformation(IntPtr token, Int32 informationClass,
        ref TOKEN_DEFAULT_DACL information, UInt32 informationLength);
    [DllImport("kernel32.dll", SetLastError=true)] static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 ms);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out UInt32 exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

    static Exception Win32(string operation) {
        int code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, operation + " failed (Win32 " + code + ")");
    }

    static string GetLogonSidText(IntPtr token) {
        UInt32 needed;
        GetTokenInformation(token, 2 /* TokenGroups */, IntPtr.Zero, 0, out needed);
        if (needed == 0) throw Win32("GetTokenInformation(TokenGroups size)");
        IntPtr buffer = Marshal.AllocHGlobal((int)needed);
        try {
            if (!GetTokenInformation(token, 2, buffer, needed, out needed)) throw Win32("GetTokenInformation(TokenGroups)");
            UInt32 count = (UInt32)Marshal.ReadInt32(buffer);
            int offset = IntPtr.Size == 8 ? 8 : 4;
            int stride = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            for (int i = 0; i < count; i++) {
                var entry = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(buffer, offset + i * stride), typeof(SID_AND_ATTRIBUTES));
                if ((entry.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID)
                    return new SecurityIdentifier(entry.Sid).Value;
            }
            throw new InvalidOperationException("Logon SID not present on token");
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    static void SetCapabilityDefaultDacl(IntPtr token, IntPtr[] sids) {
        var entries = new EXPLICIT_ACCESS[sids.Length];
        for (int i = 0; i < sids.Length; i++) {
            entries[i] = new EXPLICIT_ACCESS {
                grfAccessPermissions = GENERIC_ALL,
                grfAccessMode = 1, // GRANT_ACCESS
                grfInheritance = 0,
                Trustee = new TRUSTEE {
                    pMultipleTrustee = IntPtr.Zero,
                    MultipleTrusteeOperation = 0,
                    TrusteeForm = 0, // TRUSTEE_IS_SID
                    TrusteeType = 0, // TRUSTEE_IS_UNKNOWN
                    ptstrName = sids[i]
                }
            };
        }
        IntPtr acl;
        UInt32 result = SetEntriesInAcl((UInt32)entries.Length, entries, IntPtr.Zero, out acl);
        if (result != 0) throw new Win32Exception((int)result, "SetEntriesInAclW failed (Win32 " + result + ")");
        try {
            var info = new TOKEN_DEFAULT_DACL { DefaultDacl = acl };
            if (!SetTokenInformation(token, 6 /* TokenDefaultDacl */, ref info,
                    (UInt32)Marshal.SizeOf(typeof(TOKEN_DEFAULT_DACL)))) throw Win32("SetTokenInformation(TokenDefaultDacl)");
        } finally { if (acl != IntPtr.Zero) LocalFree(acl); }
    }

    static IntPtr CreateToken(string sidText) {
        IntPtr current = IntPtr.Zero, sid = IntPtr.Zero, logonSid = IntPtr.Zero, everyoneSid = IntPtr.Zero, restricted = IntPtr.Zero;
        try {
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY |
                    TOKEN_ADJUST_PRIVILEGES | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID, out current))
                throw Win32("OpenProcessToken");
            if (!ConvertStringSidToSid(sidText, out sid)) throw Win32("ConvertStringSidToSid");
            string logonSidText = GetLogonSidText(current);
            if (!ConvertStringSidToSid(logonSidText, out logonSid)) throw Win32("ConvertStringSidToSid(logon)");
            if (!ConvertStringSidToSid("S-1-1-0", out everyoneSid)) throw Win32("ConvertStringSidToSid(Everyone)");
            // Exact Codex-architecture order: capability, logon, Everyone.
            // CreateRestrictedToken requires Attributes=0 for every restricting SID.
            var groups = new [] {
                new SID_AND_ATTRIBUTES { Sid = sid, Attributes = 0 },
                new SID_AND_ATTRIBUTES { Sid = logonSid, Attributes = 0 },
                new SID_AND_ATTRIBUTES { Sid = everyoneSid, Attributes = 0 }
            };
            if (!CreateRestrictedToken(current, DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
                    0, IntPtr.Zero, 0, IntPtr.Zero, (UInt32)groups.Length, groups, out restricted))
                throw Win32("CreateRestrictedToken");
            SetCapabilityDefaultDacl(restricted, new [] { logonSid, everyoneSid, sid });
            LUID changeNotify;
            if (!LookupPrivilegeValue(null, "SeChangeNotifyPrivilege", out changeNotify)) throw Win32("LookupPrivilegeValueW");
            var privileges = new TOKEN_PRIVILEGES {
                PrivilegeCount = 1,
                Privileges = new LUID_AND_ATTRIBUTES { Luid = changeNotify, Attributes = 0x00000002 }
            };
            if (!AdjustTokenPrivileges(restricted, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero))
                throw Win32("AdjustTokenPrivileges");
            IntPtr result = restricted; restricted = IntPtr.Zero; return result;
        } finally {
            if (restricted != IntPtr.Zero) CloseHandle(restricted);
            if (everyoneSid != IntPtr.Zero) LocalFree(everyoneSid);
            if (logonSid != IntPtr.Zero) LocalFree(logonSid);
            if (sid != IntPtr.Zero) LocalFree(sid);
            if (current != IntPtr.Zero) CloseHandle(current);
        }
    }

    public static void Probe(string sidText) {
        IntPtr token = CreateToken(sidText);
        CloseHandle(token);
    }

    static string Quote(string value) {
        if (value.Length > 0 && value.IndexOfAny(new [] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
        var b = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append(c); slashes = 0; continue; }
            b.Append('\\', slashes); slashes = 0; b.Append(c);
        }
        b.Append('\\', slashes * 2); b.Append('"'); return b.ToString();
    }

    public static int Run(string sidText, string executable, string[] args, string cwd) {
        IntPtr token = IntPtr.Zero; PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        try {
            token = CreateToken(sidText);
            var commandLine = new StringBuilder(Quote(executable));
            foreach (string arg in args) commandLine.Append(' ').Append(Quote(arg));
            var si = new STARTUPINFO(); si.cb = (UInt32)Marshal.SizeOf(typeof(STARTUPINFO));
            if (!CreateProcessAsUser(token, executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    0, IntPtr.Zero, cwd, ref si, out pi)) throw Win32("CreateProcessAsUserW");
            WaitForSingleObject(pi.hProcess, INFINITE);
            UInt32 exitCode; if (!GetExitCodeProcess(pi.hProcess, out exitCode)) throw Win32("GetExitCodeProcess");
            return unchecked((int)exitCode);
        } finally {
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }
}
'@
Add-Type -TypeDefinition $nativeSource -Language CSharp

$sid = [System.Security.Principal.SecurityIdentifier]::new([string]$spec.syntheticSid)
$outbox = [IO.Path]::GetFullPath([string]$spec.outbox)
$directory = [IO.DirectoryInfo]::new($outbox)
$rights = [Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::Synchronize
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
$aceAdded = $false
try {
  $acl = $directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
  $acl.AddAccessRule($rule)
  $directory.SetAccessControl($acl)
  $aceAdded = $true

  [LaresRestrictedOutboxNative]::Probe([string]$spec.syntheticSid)
  if ([string]$spec.mode -eq 'probe') { exit 0 }

  $worldWritable = [Collections.Generic.List[string]]::new()
  $auditErrors = [Collections.Generic.List[string]]::new()
  foreach ($rootValue in $spec.auditRoots) {
    $root = [IO.Path]::GetFullPath([string]$rootValue)
    $items = @([IO.DirectoryInfo]::new($root)) + @(Get-ChildItem -LiteralPath $root -Directory -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
    foreach ($item in $items) {
      try {
        $itemAcl = $item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
        foreach ($candidate in $itemAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
          $isEveryone = $candidate.IdentityReference.Value -eq 'S-1-1-0'
          $writes = ($candidate.FileSystemRights -band ([Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::FullControl -bor [Security.AccessControl.FileSystemRights]::CreateFiles)) -ne 0
          if ($isEveryone -and $writes -and $candidate.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) { $worldWritable.Add($item.FullName); break }
        }
      } catch { $auditErrors.Add($item.FullName + ': ' + $_.Exception.Message) }
    }
  }
  $audit = [ordered]@{ syntheticSid = [string]$spec.syntheticSid; roots = @($spec.auditRoots); worldWritable = @($worldWritable); errors = @($auditErrors) }
  [Console]::Error.WriteLine('${OUTBOX_AUDIT_MARKER} ' + ($audit | ConvertTo-Json -Compress -Depth 4))
  $outboxPrefix = $outbox.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $unsafeWorldWritable = @($worldWritable | Where-Object {
    -not $_.Equals($outbox, [StringComparison]::OrdinalIgnoreCase) -and
    -not $_.StartsWith($outboxPrefix, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($unsafeWorldWritable.Count -gt 0) {
    throw ('world-writable directories outside the declared outbox defeat restricted-token enforcement: ' + ($unsafeWorldWritable -join ', '))
  }
  if ($auditErrors.Count -gt 0) {
    throw ('world-writable audit could not inspect every directory: ' + ($auditErrors -join ', '))
  }

  $exitCode = [LaresRestrictedOutboxNative]::Run([string]$spec.syntheticSid, [string]$spec.command, [string[]]$spec.args, [string]$spec.cwd)
  exit $exitCode
} catch {
  [Console]::Error.WriteLine('[lares-outbox-sandbox:FAIL_CLOSED] ' + $_.Exception.Message)
  exit 126
} finally {
  if ($aceAdded) {
    try {
      $cleanupAcl = $directory.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
      [void]$cleanupAcl.RemoveAccessRuleSpecific($rule)
      $directory.SetAccessControl($cleanupAcl)
    } catch { [Console]::Error.WriteLine('[lares-outbox-sandbox:ACL_CLEANUP_FAILED] ' + $_.Exception.Message) }
  }
  if ($selfPath) { Remove-Item -LiteralPath $selfPath -Force -ErrorAction SilentlyContinue }
}
`;

function syntheticSid(randomBytes: (size: number) => Buffer): string {
  const bytes = randomBytes(16);
  const parts = [0, 4, 8, 12].map((offset) => (bytes.readUInt32LE(offset) & 0x7fffffff) || 1);
  return `S-1-5-21-${parts.join('-')}`;
}

function normalizeExistingDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return fs.realpathSync.native(resolved);
}

/**
 * Prepares an OS-enforced Windows launch. The preflight creates the real token
 * and adds/removes the real outbox ACE before returning, so callers never fall
 * through to an unrestricted provider launch when setup is unavailable.
 */
export function prepareRestrictedOutboxLaunch(
  options: RestrictedOutboxLaunchOptions,
  deps: RestrictedOutboxLauncherDeps = {},
): PreparedRestrictedOutboxLaunch {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error(`${NON_WINDOWS_OUTBOX_SKIP_MARKER} restricted-token outbox enforcement requires Windows`);
  }

  const cwd = normalizeExistingDirectory(options.cwd, 'cwd');
  fs.mkdirSync(options.outbox, { recursive: true });
  const outbox = normalizeExistingDirectory(options.outbox, 'outbox');
  const auditRoots = (options.auditRoots?.length ? options.auditRoots : [cwd])
    .map((root) => normalizeExistingDirectory(root, 'audit root'));
  const sid = syntheticSid(deps.randomBytes ?? crypto.randomBytes);
  const powershell = deps.powershellPath ?? path.join(
    process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const bootstrapPath = path.join(cwd, `.lares-outbox-launch-${sid.replace(/[^A-Za-z0-9-]/g, '_')}.ps1`);
  const bootstrapArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bootstrapPath];
  const baseSpec = { syntheticSid: sid, outbox, auditRoots, command: path.resolve(options.command), args: options.args, cwd };
  const envBase = { ...(options.env ?? process.env) };
  const probeEnv = {
    ...envBase,
    [SPEC_ENV]: Buffer.from(JSON.stringify({ ...baseSpec, mode: 'probe' }), 'utf8').toString('base64'),
  };

  fs.writeFileSync(bootstrapPath, POWERSHELL_BOOTSTRAP, { encoding: 'utf8', flag: 'wx' });
  try {
    const runPreflight = deps.runPreflight ?? ((command: string, args: string[], env: NodeJS.ProcessEnv) => {
      execFileSync(command, args, { env, windowsHide: true, stdio: 'pipe', timeout: 30_000 });
    });
    runPreflight(powershell, bootstrapArgs, probeEnv);
  } catch (error) {
    try { fs.rmSync(bootstrapPath, { force: true }); } catch { /* best-effort preflight cleanup */ }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[lares-outbox-sandbox:FAIL_CLOSED] restricted token could not be established: ${detail}`);
  }

  // Probe execution removes its own script. Recreate the exact reviewed bytes
  // only after setup has succeeded; the restricted child cannot modify cwd.
  fs.writeFileSync(bootstrapPath, POWERSHELL_BOOTSTRAP, { encoding: 'utf8', flag: 'wx' });

  return {
    command: powershell,
    // Preserve provider argv at the runner boundary for launch diagnostics and
    // existing seam tests. With PowerShell -File these are inert script args;
    // the reviewed environment spec remains the only source used to spawn.
    args: [...bootstrapArgs, ...options.args],
    env: {
      [SPEC_ENV]: Buffer.from(JSON.stringify({ ...baseSpec, mode: 'launch' }), 'utf8').toString('base64'),
    },
    syntheticSid: sid,
  };
}
