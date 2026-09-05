# bapp web runtime image — static export only, no compile in-image.
#
# deploy/tag.sh runs `expo export` on the host (node toolchain lives there) and
# drops the bundle at <repo-root>/web-build; this image just packages it under
# nginx. The image is per-region agnostic: mainnet endpoints are baked into the
# production export (IS_DEV=false → https://m.bigtangle.org).
#
# Build with the repo root as the context (so `web-build/` and `deploy/` are in
# scope; see the root .dockerignore):
#   docker build -f deploy/Dockerfile.app -t bapp-web:latest .
FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY web-build/ /usr/share/nginx/html/

EXPOSE 80
