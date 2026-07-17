FROM nginx:alpine
COPY albion_market_explorer.html /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80