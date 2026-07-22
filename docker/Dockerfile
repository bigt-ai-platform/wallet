ARG JAVA_RUNTIME=eclipse-temurin:25-jdk-jammy
ARG UBUNTU_TAG=22.04
ARG BIGTANGLE_VERSION=0.5.0

FROM ubuntu:${UBUNTU_TAG} AS builder

RUN apt-get update \
 && export DEBIAN_FRONTEND=noninteractive \
 && ln -fs /usr/share/zoneinfo/Europe/London /etc/localtime \
 && apt-get install -y tzdata \
 && dpkg-reconfigure --frontend noninteractive tzdata \
 && apt-get install -y locales ntp ntpdate \
 && dpkg-reconfigure --frontend noninteractive tzdata locales \
 && locale-gen en_US.UTF-8 \
 && /usr/sbin/update-locale LANG=en_US.UTF-8

RUN apt-get update \
 && apt-get -y install git openjdk-25-jdk maven autoconf libtool make

RUN git clone https://github.com/bigtangle/secp256k1.git \
 && cd secp256k1 \
 && git checkout jni \
 && ./autogen.sh \
 && ./configure --enable-jni --enable-experimental --enable-module-schnorr --enable-module-ecdh \
 && make \
 && cp .libs/libsecp256k1.so /usr/lib/

WORKDIR /blockchain
COPY . .

RUN mvn -DskipTests=true clean install

FROM ${JAVA_RUNTIME}

RUN ulimit -n 65536 \
 && mkdir -p /app

COPY --from=builder /usr/lib/libsecp256k1.so /usr/lib/
COPY --from=builder /blockchain/helper/bigtangle/ca.pkcs12 /app/

ARG BIGTANGLE_VERSION
COPY --from=builder \
     /blockchain/layer0-server/target/layer0-server-${BIGTANGLE_VERSION}-exec.jar \
     /app/layer0-server.jar
COPY --from=builder \
     /blockchain/layer0-mcmc/target/layer0-mcmc-${BIGTANGLE_VERSION}-exec.jar \
     /app/layer0-mcmc.jar
COPY --from=builder \
     /blockchain/l1-order-server/target/l1-order-server-${BIGTANGLE_VERSION}-exec.jar \
     /app/l1-order-server.jar
COPY --from=builder \
     /blockchain/l1-order-mcmc/target/l1-order-mcmc-${BIGTANGLE_VERSION}-exec.jar \
     /app/l1-order-mcmc.jar

ENV APP_MODULE=layer0-server

ENTRYPOINT ["sh", "-c", "java ${JAVA_OPTS} --add-exports java.base/sun.nio.ch=ALL-UNNAMED -jar /app/${APP_MODULE}.jar"]
