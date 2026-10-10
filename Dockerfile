FROM node:24-alpine AS build
ARG PIPELINE_SOURCE_REVISION=
ARG PIPELINE_SOURCE_DIRTY=
ENV PIPELINE_SOURCE_REVISION=$PIPELINE_SOURCE_REVISION
ENV PIPELINE_SOURCE_DIRTY=$PIPELINE_SOURCE_DIRTY
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY scripts ./scripts
COPY application ./application
COPY deploy ./deploy
COPY Dockerfile fly.toml ./
RUN npm run build:platforms

FROM nginx:stable-alpine
RUN apk upgrade --no-cache
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /workspace/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
