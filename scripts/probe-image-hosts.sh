#!/usr/bin/env bash
# How do the QQ image hosts answer the synthetic soak URLs? (status, time, redirect target)
for url in \
  'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=synthetic-1' \
  'https://gchat.qpic.cn/gchatpic_new/0/0-0-SYNTHETIC/0' \
  'https://c2cpicdw.qpic.cn/offpic_new/0/SYNTHETIC/0'; do
  curl -s -o /dev/null -m 40 -w "%{http_code} %{time_total}s redirect=%{redirect_url} size=%{size_download}\n" "$url" || echo "curl failed ($?) for $url"
done
