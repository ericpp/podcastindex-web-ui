FROM node:16

WORKDIR /var/www/html
COPY . /var/www/html

RUN corepack enable \
    && corepack prepare yarn@stable --activate \
    && yarn install

ENTRYPOINT ["yarn", "production"]
