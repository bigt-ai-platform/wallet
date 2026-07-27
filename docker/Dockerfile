ARG JAVA_RUNTIME=eclipse-temurin:25-jdk-jammy
ARG UBUNTU_TAG=22.04
ARG BIGTANGLE_VERSION=0.6.0

FROM ${JAVA_RUNTIME}

RUN ulimit -n 65536 \
 && mkdir -p /app

COPY helper/bigtangle/ca.pkcs12 /app/

ARG BIGTANGLE_VERSION
COPY layer0-server/target/layer0-server-${BIGTANGLE_VERSION}-exec.jar /app/layer0-server.jar
COPY layer0-mcmc/target/layer0-mcmc-${BIGTANGLE_VERSION}-exec.jar /app/layer0-mcmc.jar
COPY l1-order-server/target/l1-order-server-${BIGTANGLE_VERSION}-exec.jar /app/l1-order-server.jar
COPY l1-order-mcmc/target/l1-order-mcmc-${BIGTANGLE_VERSION}-exec.jar /app/l1-order-mcmc.jar

ENV APP_MODULE=layer0-server

ENTRYPOINT ["sh", "-c", "java ${JAVA_OPTS} --add-exports java.base/sun.nio.ch=ALL-UNNAMED -jar /app/${APP_MODULE}.jar"]
