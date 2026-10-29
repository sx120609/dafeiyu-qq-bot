#!/usr/bin/env bash
# Run as root in the deployment's WSL distro. Grants only fixed qq-ai lifecycle actions.
set -euo pipefail
[[ "$(id -u)" == 0 ]] || exit 1
# The WSL user that runs the services: the one who called sudo, or the first argument.
user="${1:-${SUDO_USER:-}}"
[[ -n "$user" && "$user" != root ]] || { echo 'Usage: sudo install-runtime-control.sh [wsl-user]' >&2; exit 2; }
cat > /usr/local/bin/dafeiyu-qq-runtime <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 ]] || exit 2
case "$1" in
  status) exec /usr/bin/docker inspect --format '{{json .State}}' qq-ai ;;
  start) exec /usr/bin/docker start qq-ai ;;
  stop) exec /usr/bin/docker stop --timeout 20 qq-ai ;;
  restart) exec /usr/bin/docker restart --timeout 20 qq-ai ;;
  *) exit 2 ;;
esac
SCRIPT
chown root:root /usr/local/bin/dafeiyu-qq-runtime
chmod 0755 /usr/local/bin/dafeiyu-qq-runtime
cat > /etc/sudoers.d/dafeiyu-qq-runtime <<RULES
$user ALL=(root) NOPASSWD: /usr/local/bin/dafeiyu-qq-runtime status, /usr/local/bin/dafeiyu-qq-runtime start, /usr/local/bin/dafeiyu-qq-runtime stop, /usr/local/bin/dafeiyu-qq-runtime restart
RULES
chmod 0440 /etc/sudoers.d/dafeiyu-qq-runtime
visudo -cf /etc/sudoers.d/dafeiyu-qq-runtime
