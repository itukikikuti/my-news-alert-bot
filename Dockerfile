FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./

# Install dcron for cron scheduling
RUN apk add --no-cache dcron

# Wrapper script executed by cron
COPY run.sh /run.sh
RUN chmod +x /run.sh

# Run every 1 minute
RUN echo "* * * * * /run.sh >> /var/log/cron.log 2>&1" > /etc/crontabs/root && \
    touch /var/log/cron.log

CMD ["crond", "-f", "-l", "8"]
