# === Vendored / dependency directories ===

**/.git/**
**/**pycache**/**
**/.pytest_cache/**
**/.mypy_cache/**
**/.ruff_cache/**
**/venv/**
**/.venv/**
**/node_modules/**
**/site-packages/**
**/.pnpm-store/**
**/**Snapshots**/**
**/**snapshots**/**
**/.agents/skills/**
**/.claude/skills/**
**/.github/skills/**
**/bower_components/**
**/jspm_packages/**
**/.next/**
**/.svelte-kit/**
**/.nuxt/**
**/.output/**
**/.vercel/**
**/.angular/**
**/vendor/**
**/\_vendor/**
**/third_party/**
**/Pods/**
**/.bundle/**

# === Root-anchored ambiguous directories ===

build/**
out/**
env/**
ENV/**

# === Generated / build-output directories (match anywhere) ===

**/target/**
**/dist/**
**/generated/**
**/intermediates/**
**/generated_sources/**
**/generated-sources/**
**/generated-src/**
**/src/main/generated/**

# === Minified build output ===

**/\*.min.js
**/_.min.css
\*\*/_.bundle.js

# === Yarn PnP loader files ===

**/.pnp.cjs
**/.pnp.loader.mjs

# === Generated protobuf / codegen files ===

**/\*\_pb.d.ts
**/_\_pb.js
\*\*/_.pb.go
**/\*\_pb2.py
**/_\_pb2_grpc.py
\*\*/_\_pb2.pyi
**/\*.grpc.swift
**/_.pb.swift
\*\*/_.sql.go
**/\*.designer.cs
**/_.g.dart
\*\*/_.pb.dart
**/\*\_pb.rb
**/_.d.ts
\*\*/_.gen.ts
**/\*.gen.tsx
**/_.gen.js
\*\*/_.gen.jsx

# === Package manager files ===

**/go.mod
**/package.json
**/\*.pbxproj
**/_.xcstrings
\*\*/_.strings
**/\*.properties
**/pom.xml
**/Package.swift
**/bun.lock
**/.eslintrc
**/.eslintignore

# === Lock / sum files ===

**/go.sum
**/package-lock.json
**/pnpm-lock.yaml
**/yarn.lock
\*\*/Package.resolved

# === Images ===

**/\*.jpg
**/_.jpeg
\*\*/_.png
**/\*.gif
**/_.svg
\*\*/_.ico
**/\*.webp
**/_.bmp
\*\*/_.tiff

# === Fonts ===

**/\*.woff
**/_.woff2
\*\*/_.ttf
**/\*.eot
**/\*.otf

# === Media ===

**/\*.mp3
**/_.mp4
\*\*/_.wav
**/\*.avi
**/_.mov
\*\*/_.mkv
**/\*.flac
**/_.ogg
\*\*/_.srt

# === Archives ===

**/\*.zip
**/_.tar
\*\*/_.gz
**/\*.rar
**/_.7z
\*\*/_.bz2

# === Documents ===

**/\*.pdf
**/_.doc
\*\*/_.docx
**/\*.xls
**/_.xlsx
\*\*/_.ppt \*_/_.pptx

# === Data / serialized ===

**/\*.db
**/_.sqlite
\*\*/_.sqlite3
**/\*.parquet
**/_.avro
\*\*/_.arrow
**/\*.npy
**/_.pkl
\*\*/_.json \*_/_.jsonl

# === ML models ===

**/\*.onnx
**/_.tflite
\*\*/_.h5 \*_/_.safetensors

# === Compiled / binary ===

**/\*.exe
**/_.dll
\*\*/_.so
**/\*.dylib
**/_.bin
\*\*/_.pyc
**/\*.class
**/_.o
\*\*/_.a \*_/_.wasm

# === Certificates / keys ===

**/\*.cer
**/_.pem
\*\*/_.p12

# === Platform-specific / non-reviewable ===

**/\*.stringsdict
**/_.snap
\*\*/_.adoc
**/\*.arb
**/_.lock
\*\*/_.po
**/\*.fbx
**/_.log
\*\*/_.xib
**/\*.meta
**/_.kml
\*\*/_.prefab
**/\*.eml
**/_.csv
\*\*/_.grpc.reflection \*_/_.js.map

# === Repo-specific (added) ===

.impeccable/**
apps/builder-egghead/plans/**
apps/builder-egghead/src/data/sampleTranscript.ts
apps/web/src/content/hot-lesson-static-params.ts
