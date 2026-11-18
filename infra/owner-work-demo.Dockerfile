# Offline artifact image. First independently typecheck/lint/build the local
# candidate and inspect the cached base ID documented in OWNER-WORK-DEMO.md.
# This base supplies only the already inspected, exactly pinned production deps.
FROM vista-verde/owner-storybook-review:20261012-8a812cf
USER 0:0
WORKDIR /app
RUN rm -rf /app/dist
COPY package.json package-lock.json ./
COPY dist ./dist
COPY legacy-dist ./legacy-dist
COPY tools/verify-compiled-runtime.ts tools/verify-legacy-runtime.ts ./tools/
ARG VV_COMPILED_RUNTIME_SHA256
ARG VV_LEGACY_RUNTIME_SHA256
ARG VV_STORYBOOK_ARTIFACT_SHA256
RUN test -n "$VV_COMPILED_RUNTIME_SHA256" && node tools/verify-compiled-runtime.ts "$VV_COMPILED_RUNTIME_SHA256" > compiled-runtime-manifest.json && test -n "$VV_LEGACY_RUNTIME_SHA256" && node tools/verify-legacy-runtime.ts "$VV_LEGACY_RUNTIME_SHA256" > legacy-runtime-manifest.json && test -n "$VV_STORYBOOK_ARTIFACT_SHA256" && VV_OWNER_STORYBOOK_TEST_SHA256="$VV_STORYBOOK_ARTIFACT_SHA256" node --input-type=module -e "import {productionStorybook,storybookArtifactDigest} from './dist/apps/api/src/storybook.js'; const assets=productionStorybook(process.env.VV_OWNER_STORYBOOK_TEST_SHA256); console.log('Reviewed Storybook SHA256 '+storybookArtifactDigest(assets));"
USER 1000:1000
CMD ["node", "dist/apps/local/src/serve.js"]
