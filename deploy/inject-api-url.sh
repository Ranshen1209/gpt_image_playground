#!/bin/sh

# 用环境变量替换前端默认 API URL
DEFAULT_API_URL=${DEFAULT_API_URL:-${API_URL:-https://api.sakrylle.com/v1}}
DOCKER_LEGACY_API_URL_USED=${DOCKER_LEGACY_API_URL_USED:-false}
if [ -n "$API_URL" ]; then
    DOCKER_LEGACY_API_URL_USED=true
fi

API_PROXY_AVAILABLE=false
if [ "$ENABLE_API_PROXY" = "true" ]; then
    API_PROXY_AVAILABLE=true
fi

API_PROXY_LOCKED=false
if [ "$ENABLE_API_PROXY" = "true" ] && [ "$LOCK_API_PROXY" = "true" ]; then
    API_PROXY_LOCKED=true
fi

# 查找所有 js 文件并将占位符替换为运行时配置
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DEFAULT_API_URL_PLACEHOLDER__|$DEFAULT_API_URL|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__|$API_PROXY_AVAILABLE|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_API_PROXY_LOCKED_PLACEHOLDER__|$API_PROXY_LOCKED|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__|true|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__|$DOCKER_LEGACY_API_URL_USED|g" {} +

# Sakrylle OAuth / OIDC 配置注入
# OAUTH_BASE 仅作 OIDC 关闭时的非 OIDC 回退路径默认值；旧 host(sub) 已被墙，默认迁 oidc1。
# OIDC 开启时（生产默认）所有端点经 discovery 解析自 OIDC_ISSUER，不走 OAUTH_BASE。
OAUTH_BASE=${OAUTH_BASE:-https://oidc1.sakrylle.com}
OAUTH_CLIENT_ID=${OAUTH_CLIENT_ID:-sakrylle-image-playground}
OIDC_ENABLED=${OIDC_ENABLED:-false}
# OIDC issuer 与 OAUTH_BASE 解耦：旧 OAuth host(sub) 已被墙，OIDC 迁到独立 host。
# 做成运行时变量，将来 issuer host 再被墙时改环境变量重启即可，无需重新构建。
OIDC_ISSUER=${OIDC_ISSUER:-https://oidc1.sakrylle.com}

find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_SAKRYLLE_OAUTH_BASE_PLACEHOLDER__|$OAUTH_BASE|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_SAKRYLLE_OAUTH_CLIENT_ID_PLACEHOLDER__|$OAUTH_CLIENT_ID|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_SAKRYLLE_OIDC_ENABLED_PLACEHOLDER__|$OIDC_ENABLED|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_SAKRYLLE_OIDC_ISSUER_PLACEHOLDER__|$OIDC_ISSUER|g" {} +

# 检查是否启用了 API 代理
if [ "$ENABLE_API_PROXY" != "true" ]; then
    # 删除代理配置块
    sed -i '/# BEGIN API PROXY/,/# END API PROXY/d' /etc/nginx/conf.d/default.conf
fi

exec "$@"
