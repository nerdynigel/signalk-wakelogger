#!/bin/sh
set -eu

cert_dir=/certs
mkdir -p "$cert_dir"
if [ -s "$cert_dir/ca.crt" ] && [ -s "$cert_dir/server.crt" ] && [ -s "$cert_dir/server.key" ]; then
  exit 0
fi
rm -f "$cert_dir/ca.key" "$cert_dir/ca.crt" "$cert_dir/server.key" "$cert_dir/server.csr" "$cert_dir/server.crt" "$cert_dir/server.ext"

openssl genrsa -out "$cert_dir/ca.key" 2048
openssl req -x509 -new -sha256 -days 2 \
  -key "$cert_dir/ca.key" \
  -subj '/CN=Wake Logger disposable test CA' \
  -out "$cert_dir/ca.crt"
openssl genrsa -out "$cert_dir/server.key" 2048
openssl req -new -sha256 \
  -key "$cert_dir/server.key" \
  -subj '/CN=Wake Logger disposable test services' \
  -out "$cert_dir/server.csr"
cat > "$cert_dir/server.ext" <<'EOF'
subjectAltName=DNS:test-cloud,DNS:mosquitto,DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
EOF
openssl x509 -req -sha256 -days 2 \
  -in "$cert_dir/server.csr" \
  -CA "$cert_dir/ca.crt" \
  -CAkey "$cert_dir/ca.key" \
  -CAcreateserial \
  -extfile "$cert_dir/server.ext" \
  -out "$cert_dir/server.crt"
chmod 0644 "$cert_dir/ca.crt" "$cert_dir/server.crt" "$cert_dir/server.key"
