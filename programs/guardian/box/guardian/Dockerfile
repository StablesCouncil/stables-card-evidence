# The guardian: the program in task_guardian_program, Node.js 20, a JDK for the Council's checker and Minima's offline
# script checks, and the same official minima.jar as the node. Paths inside mirror the repo, so the program's defaults
# (the generation file, the checker, the offline tools) work unchanged.
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless git ca-certificates && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:b22182ec5c9389fe52c7cababa79e7e7966726b8996d6a31593f8ae69232af20 \
    https://github.com/minima-global/Minima/releases/download/1.0.49/minima.jar /opt/minima/minima.jar
ENV GUARDIAN_JDK=/usr/lib/jvm/java-17-openjdk-amd64/bin GUARDIAN_MINIMA_JAR=/opt/minima/minima.jar

# The files the program reads, at their repo paths.
ARG A=/app/stream_1_app/work
COPY --from=stream1 work/simcard/evidence/R2T5-DEPLOY-03/generation.json $A/simcard/evidence/R2T5-DEPLOY-03/
COPY --from=stream1 work/standalone-android/stables-android/app/src/main/assets/route2/attestation-status.json $A/standalone-android/stables-android/app/src/main/assets/route2/
COPY --from=stream1 work/simcard/measure/java/KissRunScaled.java $A/simcard/measure/java/
COPY --from=governance task_route2_tee_payments/r2t5/tools/R2T5Offline.java /app/stream_3_governance/task_route2_tee_payments/r2t5/tools/

# The Council's checker, compiled here as checker/build.sh does: the app's pure Route 2 sources plus R2Checker.
# R2MarkerProofs (app 081, proof answers) needs org.json and R2Node, like R2Node and R2Engine: left out, the checker
# does not use it. (checker/build.sh needs the same exclusion before it builds again.)
COPY --from=stream1 work/standalone-android/stables-android/app/src/main/java/org/stablescouncil/stables/route2/ /src/route2/
COPY --from=stream1 work/simcard/route2/checker/R2Checker.java work/simcard/route2/checker/R2Evidence.java /src/checker/
RUN mkdir -p $A/simcard/route2/checker/build \
 && javac --release 11 -encoding UTF-8 -Xlint:-options -cp /opt/minima/minima.jar -d $A/simcard/route2/checker/build \
      $(ls /src/route2/*.java | grep -v -E '/R2(Android|Node|Engine|MarkerProofs)') /src/checker/*.java \
 && rm -rf /src

WORKDIR /app/stream_3_governance/task_guardian_program
COPY --from=program guardian.mjs guardian-core.mjs offline.mjs alert-parlons.mjs publish-log.mjs wots-guard.mjs ./
COPY --from=program test/run-all.mjs test/logic.mjs test/offline-proof.mjs test/publish.mjs test/wots.mjs ./test/
COPY --from=program test/fixtures/ ./test/fixtures/
COPY door.mjs run.mjs setup-node.mjs parlons-setup.mjs ./box/
COPY guardian.config.json ./
CMD ["node", "box/run.mjs"]
