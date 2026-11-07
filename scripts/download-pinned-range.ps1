param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][long]$Start,
    [Parameter(Mandatory = $true)][long]$End,
    [Parameter(Mandatory = $true)][long]$Total
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
if ($PSVersionTable.PSVersion.Major -lt 6) { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 }
$client = $handler = $request = $response = $inputStream = $outputStream = $cancellation = $null
try {
    if ($Start -lt 0 -or $End -lt $Start -or $Total -le $End -or $End - $Start -ge 1048576) { throw 'Invalid pinned byte range.' }
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object Net.Http.HttpClientHandler
    # Windows PowerShell 5 ignores HTTP(S)_PROXY unless it is set explicitly.
    $taskProxy = $env:HTTPS_PROXY
    if (-not $taskProxy) { $taskProxy = $env:HTTP_PROXY }
    if ($taskProxy) { $handler.Proxy = New-Object Net.WebProxy($taskProxy); $handler.UseProxy = $true }
    $client = New-Object Net.Http.HttpClient($handler)
    $cancellation = New-Object Threading.CancellationTokenSource(60000)
    $request = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Get, $Url)
    # Invoke-WebRequest -Headers @{Range=...} is forbidden on PowerShell 5.
    $request.Headers.Range = New-Object Net.Http.Headers.RangeHeaderValue($Start, $End)
    $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancellation.Token).GetAwaiter().GetResult()
    $contentRange = $response.Content.Headers.ContentRange
    if ([int]$response.StatusCode -ne 206 -or -not $contentRange -or $contentRange.ToString() -ne "bytes $Start-$End/$Total") { throw 'Invalid pinned download range response.' }
    $expected = $End - $Start + 1
    $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $outputStream = [IO.File]::Create($Destination)
    $buffer = New-Object byte[] 65536
    $received = 0L
    while ($true) {
        $read = $inputStream.ReadAsync($buffer, 0, [int][Math]::Min($buffer.Length, $expected - $received + 1), $cancellation.Token).GetAwaiter().GetResult()
        if ($read -eq 0) { break }
        $received += $read
        if ($received -gt $expected) { throw 'Pinned byte range exceeded its expected size.' }
        $outputStream.Write($buffer, 0, $read)
    }
    if ($received -ne $expected) { throw 'Pinned byte range was incomplete.' }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    foreach ($resource in @($outputStream, $inputStream, $response, $request, $client, $handler, $cancellation)) {
        if ($null -ne $resource) { $resource.Dispose() }
    }
}
