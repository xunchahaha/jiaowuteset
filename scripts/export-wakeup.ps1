param([string]$OutputRoot)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$account = Read-Host '教务账号'
$secure = Read-Host '教务密码' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $payload = @{
        username = $account
        password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    if ($OutputRoot) { $payload.outputRoot = $OutputRoot }
    $oldEncoding = $OutputEncoding
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    $payload | ConvertTo-Json -Compress | & $node (Join-Path $PSScriptRoot 'export-wakeup.js')
    if ($LASTEXITCODE -ne 0) { throw '导出未完整完成，请查看提示。' }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    if ($payload) { $payload.Clear() }
    if ($oldEncoding) { $OutputEncoding = $oldEncoding }
    $secure.Dispose()
}
