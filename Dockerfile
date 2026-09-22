FROM node:24-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY index.js lib.js article.js ai-filter.js fcm.js server.js ./
COPY public ./public
COPY tailwind.config.js ./
COPY src ./src

# Build the Tailwind stylesheet for the admin UI, then drop dev dependencies.
RUN npx tailwindcss -i ./src/tailwind.css -o ./public/app.css --minify && \
    npm prune --omit=dev

# Install dcron for cron scheduling
RUN apk add --no-cache dcron

# Wrapper script executed by cron
COPY run.sh /run.sh
RUN chmod +x /run.sh

# Entrypoint: starts crond + web server
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Run every 1 minute
RUN echo "* * * * * /run.sh >> /data/cron.log 2>&1" > /etc/crontabs/root

EXPOSE 3334

CMD ["/entrypoint.sh"]
