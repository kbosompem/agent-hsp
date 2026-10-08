# Agent HSP brand

`agent-hsp-icon.svg` is the source for every icon: speed lines, a projector lens, a beam carrying a cross, and the screen it lands on. Gold (#f0c45c to #d9a53a) on deep navy (#1c2a4a to #070b14).

Regenerate the app icons after changing it:

```
rsvg-convert -w 1024 -h 1024 brand/agent-hsp-icon.svg -o brand/agent-hsp-icon-1024.png
cd desktop && npx tauri icon ../brand/agent-hsp-icon-1024.png -o src-tauri/icons
rm -rf src-tauri/icons/android src-tauri/icons/ios
cp ../brand/agent-hsp-icon.svg public/logo.svg && cp ../brand/agent-hsp-icon.svg ../website/logo.svg
```
