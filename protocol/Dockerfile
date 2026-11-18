# PROBE verifier. Build from the repository root:
#   docker build -f protocol/Dockerfile -t probe-verifier .
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user: cases are untrusted code.
RUN useradd --create-home --uid 10001 probe \
 && mkdir -p /data && chown probe:probe /data
USER probe
ENV PATH="/home/probe/.foundry/bin:${PATH}"
ARG FOUNDRY_VERSION=stable
RUN curl -sSL https://foundry.paradigm.xyz | bash && foundryup --install ${FOUNDRY_VERSION}

WORKDIR /app
COPY --chown=probe contracts ./contracts
COPY --chown=probe jobs ./jobs
COPY --chown=probe protocol/package.json protocol/package-lock.json ./protocol/
RUN cd protocol && npm ci --omit=dev
COPY --chown=probe protocol ./protocol
# Fetch the compiler and warm the build cache.
RUN cd contracts && forge build

ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data JOBS_ROOT=/app
VOLUME /data
EXPOSE 8787
CMD ["node", "protocol/src/verifier/server.ts"]
