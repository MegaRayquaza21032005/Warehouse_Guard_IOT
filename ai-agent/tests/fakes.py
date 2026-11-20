"""Embedding giả cho test (không gọi OpenAI): bag-of-words băm vào `dims` chiều -> câu nhiều từ chung thì giống nhau."""

import hashlib
import re


def make_fake_embed(dims: int):
    def embed(texts: list[str]) -> list[list[float]]:
        out = []
        for t in texts:
            v = [0.0] * dims
            for w in re.findall(r"\w+", t.lower()):
                v[int(hashlib.md5(w.encode()).hexdigest(), 16) % dims] += 1.0
            if not any(v):
                v[0] = 1e-6
            out.append(v)
        return out
    return embed
