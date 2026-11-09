#!/usr/bin/env bash
# Publica Fiesta Feliz en Dokploy.
#   ./desplegar.sh        -> sube la versión de la app (+1), la empaqueta y la publica
#   ./desplegar.sh api    -> publica la API de comprobantes (servidor/api)
# Lee la API key de Dokploy de $DOKPLOY_API_PRIVATE o del archivo $DOKPLOY_ENV (por defecto D:\Downloads\.env).
set -euo pipefail
cd "$(dirname "$0")"
ENVF="${DOKPLOY_ENV:-/d/Downloads/.env}"
KEY="${DOKPLOY_API_PRIVATE:-$(grep '^DOKPLOY_API_PRIVATE=' "$ENVF" | cut -d= -f2-)}"
API="${DOKPLOY_URL:-http://187.124.230.23:3000}/api"
APP_ID="0ZLJaTmVr0CADJ7CFTTYT"     # app-ventas (PWA)
API_ID="YNnACFfhXjmbT_J8cmIjp"     # api-comprobantes
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

zipear() { # zipear destino archivo...
  local dest="$1"; shift
  if command -v powershell >/dev/null; then
    local lista; lista=$(printf "'%s'," "$@"); lista=${lista%,}
    powershell -NoProfile -Command "Compress-Archive -Path $lista -DestinationPath '$(cygpath -w "$dest")' -Force"
  else
    zip -qr "$dest" "$@"
  fi
}
subir() { # subir applicationId zip
  local r; r=$(curl -s -m 120 -X POST -H "x-api-key: $KEY" -F "applicationId=$1" -F "zip=@$(cygpath -w "$2" 2>/dev/null || echo "$2");type=application/zip" "$API/application.dropDeployment")
  [ "$r" = "true" ] || { echo "Error al subir: $r"; exit 1; }
}

if [ "${1:-}" = "api" ]; then
  (cd servidor/api && zipear "$TMP/api.zip" Dockerfile package.json server.js)
  subir "$API_ID" "$TMP/api.zip"
  echo "API enviada a Dokploy."
  exit 0
fi

# 1) Subir el número de versión en los tres lugares
ACTUAL=$(python -c "import json; print(json.load(open('version.json'))['version'])")
NUEVA=$((ACTUAL + 1))
printf '{ "version": "%s" }\n' "$NUEVA" > version.json
sed -i "s/const APP_VERSION = '[0-9]*';/const APP_VERSION = '$NUEVA';/" index.html
sed -i "s/const CACHE = 'fiesta-feliz-v[0-9]*';/const CACHE = 'fiesta-feliz-v$NUEVA';/" sw.js
grep -q "APP_VERSION = '$NUEVA'" index.html && grep -q "fiesta-feliz-v$NUEVA" sw.js || { echo "No se pudo actualizar la versión"; exit 1; }
echo "Versión $ACTUAL -> $NUEVA"

# 2) Empaquetar y publicar
zipear "$TMP/app.zip" Dockerfile nginx.conf seguridad.inc index.html manifest.webmanifest sw.js version.json icons .dockerignore
subir "$APP_ID" "$TMP/app.zip"

# 3) Esperar a que esté en línea
for i in $(seq 1 30); do
  sleep 10
  EN_LINEA=$(curl -s -m 10 "https://app.lafiestafeliz.com/version.json?t=$(date +%s)" | python -c "import json,sys; print(json.load(sys.stdin)['version'])" 2>/dev/null || true)
  echo "  revisando ($i): en línea v${EN_LINEA:-?}"
  [ "$EN_LINEA" = "$NUEVA" ] && { echo "Listo: versión $NUEVA publicada en https://app.lafiestafeliz.com"; exit 0; }
done
echo "La versión aún no aparece en línea; revise Dokploy."; exit 1
