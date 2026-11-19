# CCE Remote: build the static app, then serve it with nginx on port 80.
# Coolify: build pack "Dockerfile", base directory "remote-app", port 80.
#
# Both base images are pinned to exact versions, so a rebuild serves what was tested. To update, pull
# node:22-alpine and nginx:alpine, read NODE_VERSION / NGINX_VERSION (`docker image inspect`) and
# /etc/alpine-release in each, and put those numbers below.

FROM node:22.23.5-alpine3.24 AS build
WORKDIR /app
# Exact versions from the lockfile only (npm ci fails if package.json and the lockfile disagree).
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.31.9-alpine3.24
# The tailnet the app may connect to (the CSP's connect-src): ts.net allows any tailnet; your tailnet's DNS
# name (e.g. tailnet-0000.ts.net, in Tailscale's admin console under DNS) narrows it to your own Macs.
ENV CCE_REMOTE_TAILNET=ts.net
# The image fills the CCE_* variables into nginx.conf at start (nginx's own $variables stay as they are),
# after check-tailnet.sh made sure the value is a DNS name.
ENV NGINX_ENVSUBST_FILTER=^CCE_
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY check-tailnet.sh /docker-entrypoint.d/18-cce-remote-tailnet.sh
RUN chmod 755 /docker-entrypoint.d/18-cce-remote-tailnet.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q --spider http://127.0.0.1/ || exit 1
