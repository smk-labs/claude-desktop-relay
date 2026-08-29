# The tray: a notification-area item over the relay's own local API.
#
# Thin on purpose, and deliberately the same shape as the Swift one on macOS. It
# reads one small document from the relay and draws a menu from it; it holds no
# state, decides nothing, and knows nothing about Seats or Modes beyond the words
# the relay hands it. Everything it shows is decided in `src/page/internal/tray.ts`,
# so the menu and the page can never disagree about who is paying.
#
# Windows Forms rather than anything installed, for the same reason the macOS side
# is one Swift file compiled by the toolchain that is already there: nothing is
# installed, nothing is downloaded, nothing is vendored. The notification area is
# a native thing and cannot be a Node process on either machine.
#
# The byte order mark at the very top of this file is load-bearing, and it is
# invisible. Windows PowerShell reads a .ps1 that has no mark as the machine's ANSI
# code page rather than as UTF-8, so the middle dots and the ellipsis below are
# decoded a byte at a time and drawn in the menu as two characters of rubbish each.
# Measured 2026-08-25. A mark is how that shell is told.
#
#   powershell -NoProfile -File relay-tray.ps1 -Port 8978

param([int]$Port = 8978)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$relay = "http://127.0.0.1:$Port"

# ---------------------------------------------------------------- the icon ----
#
# Four states, told apart by shape as well as by colour, because a notification
# area is read at a glance and a person who cannot tell two colours apart still
# has to be able to tell a relay that is off from one that is broken.
#
#   off       a plug with no cord
#   on        a plug with a cord
#   strained  a cord with one end run down
#   broken    a cord cut in two
#
# Drawn rather than shipped, so there is no binary in the repository and no icon
# file to keep in step with the four states the relay actually reports.

$icons = @{}
function Get-CordIcon([string]$state) {
  if ($icons.ContainsKey($state)) { return $icons[$state] }

  $size = 32
  $bitmap = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $ink = switch ($state) {
    'on'       { [System.Drawing.Color]::FromArgb(255, 64, 190, 120) }
    'strained' { [System.Drawing.Color]::FromArgb(255, 230, 170, 60) }
    'broken'   { [System.Drawing.Color]::FromArgb(255, 226, 90, 80) }
    default    { [System.Drawing.Color]::FromArgb(255, 150, 150, 155) }
  }
  $pen = New-Object System.Drawing.Pen $ink, 3.0
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $brush = New-Object System.Drawing.SolidBrush $ink

  # The plug, which every state has.
  $g.FillEllipse($brush, 4, 12, 9, 9)

  switch ($state) {
    'off' { }
    'broken' {
      # Cut: two ends that do not meet, which reads as broken at any size.
      $g.DrawLine($pen, 13, 16, 18, 16)
      $g.DrawLine($pen, 24, 16, 28, 16)
    }
    'strained' {
      # A cord whose far end has run down.
      $g.DrawLine($pen, 13, 16, 28, 16)
      $g.FillRectangle($brush, 24, 20, 5, 7)
    }
    default {
      $g.DrawLine($pen, 13, 16, 28, 16)
      $g.FillEllipse($brush, 23, 12, 9, 9)
    }
  }

  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
  $icons[$state] = $icon
  return $icon
}

# ------------------------------------------------------------- the relay ------

function Read-Tray {
  try {
    return Invoke-RestMethod -Uri "$relay/tray" -TimeoutSec 4 -Method Get
  } catch {
    return $null
  }
}

function Send-Act($body) {
  try {
    Invoke-RestMethod -Uri "$relay/act" -TimeoutSec 8 -Method Post -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) | Out-Null
  } catch {
    # The relay refusing is the relay's answer. The next read redraws the menu
    # from what is actually true rather than from what was asked for.
  }
  Update-Menu
}

# -------------------------------------------------------------- the menu ------

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = Get-CordIcon 'off'
$notify.Text = 'Relay is starting'
$notify.Visible = $true

function New-Row([string]$text, [scriptblock]$onClick, [bool]$ticked) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem
  $item.Text = $text
  $item.Checked = $ticked
  if ($null -eq $onClick) { $item.Enabled = $false } else { $item.Add_Click($onClick) }
  return $item
}

# A heading, with an optional hint on the same line. The same four words in the
# same order as the macOS and Linux trays: see src/tray/menu.ts, which is where the
# vocabulary is written down and which the parity test reads.
function New-Heading([string]$text, [string]$hint = '') {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem
  $item.Text = if ($hint -eq '') { $text } else { "$text    $hint" }
  $item.Enabled = $false
  return $item
}

function Update-Menu {
  $menu = Read-Tray
  $drawn = New-Object System.Windows.Forms.ContextMenuStrip

  if ($null -eq $menu) {
    $notify.Icon = Get-CordIcon 'broken'
    $notify.Text = 'Relay is not answering'
    $drawn.Items.Add((New-Heading 'Relay is not answering')) | Out-Null
    $drawn.Items.Add((New-Row 'Quit Relay tray' { $notify.Visible = $false; [System.Windows.Forms.Application]::Exit() } $false)) | Out-Null
    $notify.ContextMenuStrip = $drawn
    return
  }

  $notify.Icon = Get-CordIcon $menu.icon
  <#
    The tooltip is the only summary anybody gets without clicking, and "Relay is
    on" is not a summary. So it is what the paying Seat has spent, in the whole
    words the relay writes for exactly this, and the relay's own sentence only
    when nothing is paying.

    Windows caps it at 63 characters and truncates silently past that, so it is
    cut here instead, where the cut can be seen.
  #>
  $tip = if ($menu.payingRoom) { "{0}  {1}" -f $menu.paying.name, $menu.payingRoom } else { [string]$menu.saying }
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 60) + [string][char]0x2026 }
  $notify.Text = $tip

  $drawn.Items.Add((New-Heading 'Paying now')) | Out-Null
  if ($null -ne $menu.paying) {
    # One row, ticked, exactly as the macOS menu draws it: the name and plan, then
    # what it has spent. Two rows were this tray's own invention and made the same
    # fact look like a different fact on the other machine.
    $drawn.Items.Add((New-Row ("{0} · {1}    {2}" -f $menu.paying.name, $menu.paying.plan, $menu.paying.room) $null $true)) | Out-Null
  } else {
    $drawn.Items.Add((New-Row ([string]$menu.payingSaying) $null $false)) | Out-Null
  }

  $drawn.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
  $drawn.Items.Add((New-Heading 'Mode')) | Out-Null
  foreach ($mode in @(@('auto', 'Auto'), @('manual', 'Manual'), @('off', 'Off'))) {
    $name = $mode[0]
    $drawn.Items.Add((New-Row $mode[1] ([scriptblock]::Create("Send-Act @{ mode = '$name' }")) ($menu.mode -eq $name))) | Out-Null
  }

  if ($menu.seats -and $menu.seats.Count -gt 0) {
    $drawn.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
    $drawn.Items.Add((New-Heading 'Switch to' 'sets Manual')) | Out-Null
    foreach ($seat in $menu.seats) {
      $name = [string]$seat.name
      # `room` and never `left`: it says both windows, whether the figure is spent
      # or left, and when each comes back. `left` said one number and not which.
      $label = "{0} · {1}    {2}" -f $seat.name, $seat.plan, $seat.room
      $drawn.Items.Add((New-Row $label ([scriptblock]::Create("Send-Act @{ use = '$name' }")) $false)) | Out-Null
    }
  }

  if ($menu.profiles -and $menu.profiles.Count -gt 0) {
    $drawn.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
    $drawn.Items.Add((New-Heading 'Claude Desktop' 'click to open')) | Out-Null
    foreach ($profile in $menu.profiles) {
      $name = [string]$profile.name
      # Opening only. Nothing in this menu closes a Window, and whether a profile
      # is relayed is shown here and changed nowhere in it. The tick is on the
      # profile this relay is behind, which is the fact a person came here for.
      $label = if ($profile.running) { "{0} ●    {1}" -f $profile.name, $profile.saying } else { "{0}    {1}" -f $profile.name, $profile.saying }
      $drawn.Items.Add((New-Row $label ([scriptblock]::Create("Send-Act @{ open = '$name' }")) ([bool]$profile.relayed))) | Out-Null
    }
  }

  $drawn.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
  if ($menu.relaying) {
    $drawn.Items.Add((New-Heading 'Relaying' ([string]$menu.relaying))) | Out-Null
  }
  # When these figures were read. Every number above is a reading taken at some
  # earlier moment, and a menu that never dates itself looks equally current an
  # hour later. Worded by the relay, so all three trays say it the same way.
  if ($menu.refreshed) {
    $drawn.Items.Add((New-Heading ([string]$menu.refreshed))) | Out-Null
  }
  $open = if ($menu.open) { [string]$menu.open } else { $relay }
  $drawn.Items.Add((New-Row 'Open Relay…' ([scriptblock]::Create("Start-Process '$open'")) $false)) | Out-Null
  $drawn.Items.Add((New-Row 'Quit Relay tray' { $notify.Visible = $false; [System.Windows.Forms.Application]::Exit() } $false)) | Out-Null

  $notify.ContextMenuStrip = $drawn
}

# A left click opens the menu too, because a one-icon tray where only the right
# button does anything is a tray people think is broken.
$notify.Add_MouseUp({
  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    Update-Menu
    $notify.GetType().GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'NonPublic,Instance').Invoke($notify, $null)
  }
})

# Every few seconds, because the menu is read at a glance and a menu that is wrong
# at a glance is worse than no menu. The same interval the macOS one uses.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.Add_Tick({ Update-Menu })
$timer.Start()

Update-Menu
[System.Windows.Forms.Application]::Run()
$notify.Visible = $false
