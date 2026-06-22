try {
  $found = $false
  Get-Process | ForEach-Object {
    try {
      $mods = $_.Modules
    } catch {
      return
    }
    if ($mods | Where-Object { $_.FileName -like '*ffmpeg.dll' }) {
      $found = $true
      Write-Output "Found: $($_.Name) $($_.Id) $($_.Path)"
      try {
        Stop-Process -Id $_.Id -Force -ErrorAction Stop
        Write-Output "Stopped: $($_.Name) $($_.Id)"
      } catch {
        Write-Output "Failed to stop: $($_.Name) $($_.Id) - $($_.Exception.Message)"
      }
    }
  }
  if (-not $found) { Write-Output 'No processes holding ffmpeg.dll found.' }
} catch {
  Write-Output "Error: $($_.Exception.Message)"
}
