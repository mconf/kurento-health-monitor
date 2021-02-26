FROM node:14-alpine

RUN apk update && apk add git

ADD . app

WORKDIR app

ENV NODE_ENV production

RUN cp config/default.example.yml config/production.yml

RUN npm install \
 && npm cache clear --force

CMD [ "npm", "start" ]
