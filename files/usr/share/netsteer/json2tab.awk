# NetSteer: dnslog JSON 数组行 → tab 七字段流 (v/proto/src/dst/port/up/q)
# 单一来源: netsteer-qos qos_json2tab 与单测共用
{
	line = $0
	while ((p = index(line, "{")) > 0) {
		line = substr(line, p + 1)
		e = index(line, "}")
		if (e == 0) break
		obj = substr(line, 1, e - 1); line = substr(line, e + 1)
		gsub(/"/, "", obj)
		v = t = c = d = pp = u = q = ""
		m = split(obj, kv, ",")
		for (k = 1; k <= m; k++) {
			eq = index(kv[k], ":")
			if (eq == 0) continue
			key = substr(kv[k], 1, eq - 1); val = substr(kv[k], eq + 1)
			if (key == "v") v = val; else if (key == "t") t = val
			else if (key == "c") c = val; else if (key == "d") d = val
			else if (key == "p") pp = val; else if (key == "u") u = val
			else if (key == "q") q = val
		}
		printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", v, t, c, d, pp, u, q
	}
}
