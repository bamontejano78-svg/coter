FROM nginx:1.27-alpine

# Usar build arg para decidir entorno (staging | production)
ARG ENV=production

# Copiar config según entorno
COPY nginx.${ENV}.conf /etc/nginx/conf.d/default.conf

# Copiar certificados SSL self-signed (solo staging)
COPY certs/ /etc/nginx/certs/

# Crear directorio para certbot (Let's Encrypt)
RUN mkdir -p /var/www/certbot

# Healthcheck
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD nginx -t || exit 1

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
