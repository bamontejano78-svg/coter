FROM nginx:1.27-alpine

# Usar build arg para decidir entorno (staging | production)
ARG ENV=production

# Copiar la configuración correcta según el entorno.
# Producción usa nginx.conf; staging usa nginx.staging.conf.
COPY nginx.conf /tmp/nginx.production.conf
COPY nginx.staging.conf /tmp/nginx.staging.conf
COPY limits.conf /etc/nginx/conf.d/00-limits.conf
RUN if [ "$ENV" = "staging" ]; then cp /tmp/nginx.staging.conf /etc/nginx/conf.d/default.conf; else cp /tmp/nginx.production.conf /etc/nginx/conf.d/default.conf; fi

# El certificado self-signed se incluye únicamente en la imagen de staging.
# La producción usa /etc/letsencrypt montado desde el host.
RUN mkdir -p /etc/nginx/certs
RUN if [ "$ENV" = "staging" ]; then exit 0; fi

# Crear directorio para certbot (Let's Encrypt)
RUN mkdir -p /var/www/certbot

# El certificado de staging solo se usa en la imagen de staging; en producción
# los certificados de Let's Encrypt se montan desde el host.
# Healthcheck
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD nginx -t || exit 1

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
