#!/usr/bin/env bash
# Installs the veraPDF command-line validator (needs Java 11+) into ~/.cache/verapdf/app.
set -euo pipefail

dest="$HOME/.cache/verapdf"
[ -x "$dest/app/verapdf" ] && { echo "veraPDF already installed at $dest/app"; exit 0; }
mkdir -p "$dest"
curl -sSL -o "$dest/installer.zip" https://software.verapdf.org/releases/verapdf-installer.zip
unzip -o -q "$dest/installer.zip" -d "$dest"
installer=$(find "$dest" -name 'verapdf-izpack-installer-*.jar' | head -1)
cat > "$dest/auto.xml" <<XML
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<AutomatedInstallation langpack="eng">
    <com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
    <com.izforge.izpack.panels.target.TargetPanel id="install_dir"><installpath>$dest/app</installpath></com.izforge.izpack.panels.target.TargetPanel>
    <com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select">
        <pack index="0" name="veraPDF Greenfield" selected="true"/>
        <pack index="1" name="veraPDF PDFBox" selected="false"/>
        <pack index="2" name="veraPDF Documentation" selected="false"/>
        <pack index="3" name="veraPDF Sample Plugins" selected="false"/>
    </com.izforge.izpack.panels.packs.PacksPanel>
    <com.izforge.izpack.panels.install.InstallPanel id="install"/>
    <com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>
XML
java -jar "$installer" "$dest/auto.xml" > /dev/null
[ -x "$dest/app/verapdf" ] || { echo "veraPDF install failed" >&2; exit 1; }
echo "veraPDF installed at $dest/app"
