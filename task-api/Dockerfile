# Task API Dockerfile
# 构建上下文为项目根目录，server.js 只保留一份

FROM node:22-alpine

# Install Docker CLI for callback (docker exec into bot containers)
RUN apk add --no-cache docker-cli

WORKDIR /app

# 安装依赖（用 Docker 专用的精简 package.json）
COPY docker/task-api/package.json ./
RUN npm install --production

# 复制唯一正本 server.js
COPY server.js ./

# 暴露端口
EXPOSE 3456

# 启动服务
CMD ["node", "server.js"]
