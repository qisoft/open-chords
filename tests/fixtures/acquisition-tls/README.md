# Synthetic TLS peer

These are public test credentials, not deployment secrets. The self-signed test CA and its `www.youtube.com` leaf are used only by a loopback HTTPS fixture. The CA is trusted through `NODE_EXTRA_CA_CERTS` in the isolated test child, never installed in the OS or packaged application.

The external TCP adapter sends the already validated public destination to this loopback fixture. The production HTTPS agent retains certificate trust and original-host verification. Tests cover a matching trusted leaf, an untrusted chain, and a hostname mismatch. The test CA private key is not retained.

Generated with OpenSSL 3.6.2 for this synthetic test, with ten-year validity. Renew the fixture before its certificate expiry. No connection to YouTube is made by these tests.
