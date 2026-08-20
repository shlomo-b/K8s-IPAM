FROM python:3.12-slim

WORKDIR /app

# for CI github actions
COPY ipam-k8s-app/requirements.txt .
# for local testing
# COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# for CI github actions
COPY ipam-k8s-app/app ./app
COPY ipam-k8s-app/static ./static
# for local testing
# COPY app ./app
# COPY static ./static

# ------------ NEW (security best practice) -------------
# Create a non-root user and give it the app files
RUN adduser --disabled-password --gecos "" appuser --uid 1000 \
    && chown -R appuser:appuser /app

# Switch to the new user
USER appuser

EXPOSE 8088

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8088"]
