/** These are HTTP/mixed port suggestions, not probes or promises that a service is listening. */
export const LOCAL_HTTP_PROXY_PORTS = [7897, 7890, 7896, 7898, 10809, 8080] as const;
export const NETWORK_SOURCE_PRESETS = {
  npm: [
    { name: 'npm', url: 'https://registry.npmjs.org' },
    { name: 'npmmirror', url: 'https://registry.npmmirror.com' },
    { name: 'Huawei Cloud', url: 'https://mirrors.huaweicloud.com/npm' },
  ],
  python: [
    { name: 'PyPI', url: 'https://pypi.org/simple' },
    { name: 'TUNA', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
    { name: 'USTC', url: 'https://mirrors.ustc.edu.cn/pypi/simple' },
    { name: 'Aliyun', url: 'https://mirrors.aliyun.com/pypi/simple' },
    { name: 'Huawei Cloud', url: 'https://repo.huaweicloud.com/repository/pypi/simple' },
  ],
} as const;
