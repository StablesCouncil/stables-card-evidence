# The guardian's Parlons account: Parlons Cloud, built from Eurobuddha's source at a pinned commit (no release jar is
# published). Android modules left out (-PskipAndroid=true).
FROM eclipse-temurin:17-jdk AS build
ARG PARLONS_COMMIT=6c71fbfde539419bf06fe4e096aa9209fbad72a9
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/eurobuddha/maxima.git \
 && git fetch -q --depth 1 origin ${PARLONS_COMMIT} && git checkout -q FETCH_HEAD
# The repo's gradle.properties names a Mac Java (org.gradle.java.home): overridden with this image's. Slow networks:
# longer timeouts, three tries, and a Gradle cache that keeps what was already downloaded.
RUN sed -i 's/^networkTimeout=.*/networkTimeout=180000/' gradle/wrapper/gradle-wrapper.properties
RUN --mount=type=cache,target=/root/.gradle \
    for t in 1 2 3; do \
      ./gradlew --no-daemon -PskipAndroid=true -Dorg.gradle.java.home=$JAVA_HOME \
        -Dorg.gradle.internal.http.connectionTimeout=180000 -Dorg.gradle.internal.http.socketTimeout=180000 \
        :cloud:fatJar && break; \
      [ $t = 3 ] && exit 1; echo "gradle try $t failed, again"; \
    done \
 && cp "$(ls cloud/build/libs/*.jar | head -1)" /parlons-cloud.jar && sha256sum /parlons-cloud.jar

FROM eclipse-temurin:17-jre
RUN apt-get update && apt-get install -y --no-install-recommends socat && rm -rf /var/lib/apt/lists/*
COPY --from=build /parlons-cloud.jar /opt/parlons/parlons-cloud.jar
COPY start.sh /opt/parlons/start.sh
RUN chmod 755 /opt/parlons/start.sh
CMD ["/opt/parlons/start.sh"]
