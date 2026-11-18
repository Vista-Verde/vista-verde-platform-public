FROM node@sha256:3529ef69feecddd94e9c5ecd3d25a96f2f23ea40661f494f932ae2b12ab1977c AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --global npm@11.12.1 --ignore-scripts --no-audit --no-fund && npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY packages ./packages
COPY apps ./apps
COPY .storybook ./.storybook
COPY tools/copy-schema.ts tools/build-web.ts tools/copy-storybook.ts ./tools/
RUN npm run build && npm run build-storybook && node tools/copy-storybook.ts && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node@sha256:3529ef69feecddd94e9c5ecd3d25a96f2f23ea40661f494f932ae2b12ab1977c
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 1000:1000
CMD ["node", "dist/apps/local/src/serve.js"]
