FROM nginx:alpine
COPY albion_market_explorer.html /usr/share/nginx/html/index.html
EXPOSE 80