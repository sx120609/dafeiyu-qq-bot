# Derives the console avatar and launcher icon from the upstream logo (YunYueSama, see upstream/Resources/QQControl/LOGO-LICENSE.txt).
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$workspace=Split-Path -Parent $PSScriptRoot
$source=[Drawing.Image]::FromFile("$workspace\upstream\Resources\QQControl\logo.png")
function Resize([int]$size){
    $bitmap=New-Object Drawing.Bitmap -ArgumentList $size,$size
    $graphics=[Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode=[Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($source,[Drawing.Rectangle]::new(0,0,$size,$size))
    $graphics.Dispose()
    $stream=New-Object IO.MemoryStream
    $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png);$bitmap.Dispose()
    return ,$stream.ToArray()
}
[IO.File]::WriteAllBytes("$workspace\console\avatar.png",(Resize 160))
# PNG-compressed ICO entries (supported since Windows Vista).
$sizes=@(16,24,32,48,64,256)
$images=@($sizes|ForEach-Object{,(Resize $_)})
$icon=New-Object IO.MemoryStream;$writer=New-Object IO.BinaryWriter $icon
$writer.Write([UInt16]0);$writer.Write([UInt16]1);$writer.Write([UInt16]$sizes.Count)
$offset=6+16*$sizes.Count
for($i=0;$i -lt $sizes.Count;$i++){
    $dimension=if($sizes[$i] -ge 256){0}else{$sizes[$i]}
    $writer.Write([byte]$dimension);$writer.Write([byte]$dimension);$writer.Write([byte]0);$writer.Write([byte]0)
    $writer.Write([UInt16]1);$writer.Write([UInt16]32);$writer.Write([UInt32]$images[$i].Length);$writer.Write([UInt32]$offset)
    $offset+=$images[$i].Length
}
foreach($image in $images){$writer.Write($image)}
$writer.Flush();New-Item -ItemType Directory -Force "$workspace\launcher"|Out-Null
[IO.File]::WriteAllBytes("$workspace\launcher\dafeiyu.ico",$icon.ToArray())
$source.Dispose()
Write-Output 'Console avatar and launcher icon written.'
