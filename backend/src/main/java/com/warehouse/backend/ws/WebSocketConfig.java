package com.warehouse.backend.ws;

import java.util.Map;

import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final LiveWebSocketHandler handler;
    private final JwtDecoder jwtDecoder;

    public WebSocketConfig(LiveWebSocketHandler handler, JwtDecoder jwtDecoder) {
        this.handler = handler;
        this.jwtDecoder = jwtDecoder;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // Có kiểm tra token nên cho mọi origin (React Native không gửi Origin)
        registry.addHandler(handler, "/ws/live").addInterceptors(new JwtHandshakeInterceptor())
                .setAllowedOriginPatterns("*");
    }

    /** Kiểm tra access token trong query ?token=... trước khi nâng cấp lên WebSocket. */
    private class JwtHandshakeInterceptor implements HandshakeInterceptor {

        @Override
        public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                WebSocketHandler wsHandler, Map<String, Object> attributes) {
            String token = UriComponentsBuilder.fromUri(request.getURI()).build().getQueryParams()
                    .getFirst("token");
            if (token == null || token.isBlank()) {
                response.setStatusCode(HttpStatus.UNAUTHORIZED);
                return false;
            }
            try {
                attributes.put("userId", jwtDecoder.decode(token).getSubject());
                return true;
            } catch (JwtException e) {
                response.setStatusCode(HttpStatus.UNAUTHORIZED);
                return false;
            }
        }

        @Override
        public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                WebSocketHandler wsHandler, Exception exception) {
            // không cần
        }
    }
}
