# Héritage — image de production.
#
# Trois étages : on installe, on compile, on ne garde que le nécessaire.
# L'image finale ne contient ni le code source, ni les dépendances de
# développement, ni le client de test.

# ─── 1. Dépendances ───
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
RUN npm ci

# ─── 2. Compilation ───
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `build` lance `prisma generate` puis `next build`.
# La clé de signature n'est PAS nécessaire ici : elle n'est lue qu'à
# l'exécution. Ne jamais l'inscrire dans une image.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ─── 3. Exécution ───
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl postgresql-client \
 && addgroup -g 1001 -S nodejs \
 && adduser -S heritage -u 1001

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/public ./public
COPY --from=builder --chown=heritage:nodejs /app/.next/standalone ./
COPY --from=builder --chown=heritage:nodejs /app/.next/static ./.next/static

# Prisma : le schéma, les migrations et le moteur, pour pouvoir appliquer
# les migrations au démarrage sans embarquer tout le CLI.
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma

# Les archives vivent sur un volume : elles ne doivent PAS disparaître
# au redéploiement. C'est la mémoire d'une famille.
RUN mkdir -p /data/archives && chown -R heritage:nodejs /data
ENV STORAGE_DIR=/data/archives
VOLUME ["/data"]

USER heritage
EXPOSE 3000

# Les migrations s'appliquent avant que le serveur n'accepte une requête.
#
# ⚠ On appelle le fichier de la CLI DIRECTEMENT, et non `node_modules/.bin/prisma`.
#
# `.bin/prisma` est un LIEN SYMBOLIQUE que npm crée dans `node_modules/.bin/`,
# et cet étage ne copie que `prisma`, `@prisma` et `.prisma` — jamais `.bin/`.
# Dans l'image finale, `node_modules/.bin/prisma` n'existe donc pas : le
# conteneur sortait sur « not found » AVANT d'atteindre `node server.js`.
# De l'extérieur cela se voyait comme une application qui ne répond pas,
# sans erreur applicative — la panne la plus coûteuse à diagnostiquer.
#
# Constaté en reproduisant l'ensemble copié à l'identique hors Docker :
#   sh: node_modules/.bin/prisma: not found
#   node node_modules/prisma/build/index.js --version  →  prisma 5.22.0
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node server.js"]
