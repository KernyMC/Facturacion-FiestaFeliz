# Fiesta Feliz - PWA servida con nginx
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY seguridad.inc /etc/nginx/conf.d/seguridad.inc
COPY index.html manifest.webmanifest sw.js version.json /usr/share/nginx/html/
COPY icons /usr/share/nginx/html/icons
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
