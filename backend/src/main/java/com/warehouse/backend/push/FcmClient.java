package com.warehouse.backend.push;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;

import tools.jackson.databind.ObjectMapper;

/**
 * Gửi FCM HTTP v1 bằng service account (OAuth2 JWT bearer, RS256) — không cần Firebase Admin SDK.
 * Đọc file JSON service account: project_id, client_email, private_key, token_uri.
 */
public class FcmClient {

    private static final String SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

    public enum Result {
        OK, INVALID_TOKEN, ERROR
    }

    private final ObjectMapper mapper;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(10)).build();
    private final String projectId;
    private final String clientEmail;
    private final String tokenUri;
    private final PrivateKey key;
    private final String fcmUrl;
    private String accessToken;
    private Instant accessTokenExpiry = Instant.EPOCH;

    @SuppressWarnings("unchecked")
    public FcmClient(Path credentialsFile, String fcmUrl, ObjectMapper mapper) throws Exception {
        this.mapper = mapper;
        Map<String, Object> sa = mapper.readValue(Files.readString(credentialsFile), Map.class);
        this.projectId = (String) sa.get("project_id");
        this.clientEmail = (String) sa.get("client_email");
        this.tokenUri = (String) sa.getOrDefault("token_uri", "https://oauth2.googleapis.com/token");
        String pem = ((String) sa.get("private_key")).replaceAll("-----[A-Z ]+-----", "").replaceAll("\\s", "");
        this.key = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(pem)));
        this.fcmUrl = fcmUrl.replaceAll("/$", "");
        if (projectId == null || clientEmail == null) {
            throw new IllegalArgumentException("File service account thiếu project_id / client_email");
        }
    }

    public String projectId() {
        return projectId;
    }

    /** Gửi một message FCM v1 ({"message": {...}}). */
    public Result send(Map<String, Object> message) {
        try {
            String body = mapper.writeValueAsString(Map.of("message", message));
            HttpResponse<String> res = http.send(HttpRequest.newBuilder()
                    .uri(URI.create(fcmUrl + "/v1/projects/" + projectId + "/messages:send"))
                    .timeout(Duration.ofSeconds(15))
                    .header("Authorization", "Bearer " + accessToken())
                    .header("Content-Type", "application/json; charset=UTF-8")
                    .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() == 200) {
                return Result.OK;
            }
            // token đã gỡ app / hết hạn -> xóa khỏi DB
            if (res.statusCode() == 404 || res.body().contains("UNREGISTERED")
                    || (res.statusCode() == 400 && res.body().contains("registration token"))) {
                return Result.INVALID_TOKEN;
            }
            if (res.statusCode() == 401) {
                synchronized (this) {
                    accessTokenExpiry = Instant.EPOCH;
                }
            }
            throw new IllegalStateException("FCM " + res.statusCode() + ": " + abbreviate(res.body()));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Result.ERROR;
        } catch (Exception e) {
            throw e instanceof RuntimeException r ? r : new IllegalStateException(e.getMessage(), e);
        }
    }

    private synchronized String accessToken() throws Exception {
        if (accessToken != null && Instant.now().isBefore(accessTokenExpiry.minusSeconds(60))) {
            return accessToken;
        }
        long now = Instant.now().getEpochSecond();
        String header = b64(mapper.writeValueAsBytes(Map.of("alg", "RS256", "typ", "JWT")));
        String claims = b64(mapper.writeValueAsBytes(Map.of("iss", clientEmail, "scope", SCOPE, "aud", tokenUri,
                "iat", now, "exp", now + 3600)));
        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign(key);
        sig.update((header + "." + claims).getBytes(StandardCharsets.US_ASCII));
        String jwt = header + "." + claims + "." + b64(sig.sign());
        String form = "grant_type=" + URLEncoder.encode("urn:ietf:params:oauth:grant-type:jwt-bearer", StandardCharsets.UTF_8)
                + "&assertion=" + jwt;
        HttpResponse<String> res = http.send(HttpRequest.newBuilder().uri(URI.create(tokenUri))
                .timeout(Duration.ofSeconds(15)).header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form)).build(), HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != 200) {
            throw new IllegalStateException("Không lấy được access token Google (" + res.statusCode() + "): "
                    + abbreviate(res.body()));
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> t = mapper.readValue(res.body(), Map.class);
        accessToken = (String) t.get("access_token");
        long ttl = t.get("expires_in") instanceof Number n ? n.longValue() : 3600;
        accessTokenExpiry = Instant.now().plusSeconds(ttl);
        return accessToken;
    }

    private static String b64(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static String abbreviate(String s) {
        return s == null ? "" : s.length() > 300 ? s.substring(0, 300) + "…" : s;
    }
}
