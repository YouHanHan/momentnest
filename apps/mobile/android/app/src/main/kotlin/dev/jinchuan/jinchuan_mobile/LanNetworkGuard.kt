package dev.jinchuan.jinchuan_mobile

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.Inet4Address
import java.net.InetAddress

/** 仅绑定无需网关的 Wi-Fi 或有线局域网，断开后由系统使套接字失败。 */
class LanNetworkGuard(context: Context) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)

    fun bind(host: String) {
        val target = parseLanAddress(host)
        val networks = connectivity.allNetworks
        check(networks.none { connectivity.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }) {
            "仅允许局域网直连，请断开手机 VPN 后重试。"
        }
        val network = networks.firstOrNull { candidate ->
            val capabilities = connectivity.getNetworkCapabilities(candidate) ?: return@firstOrNull false
            if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN) ||
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ||
                !(capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) {
                return@firstOrNull false
            }
            val links = connectivity.getLinkProperties(candidate) ?: return@firstOrNull false
            val local = links.linkAddresses.any { link ->
                val address = link.address
                address is Inet4Address && link.prefixLength in 1..30 && sameSubnet(address, target, link.prefixLength)
            }
            local && links.routes.any { route ->
                !route.isDefaultRoute && route.matches(target) && (route.gateway == null || route.gateway!!.isAnyLocalAddress)
            }
        }
        check(network != null) { "电脑不在直连局域网内。请连接与电脑同网段的 Wi-Fi 或有线网络；不允许移动数据或跨网段传输。" }
        check(connectivity.bindProcessToNetwork(network)) { "局域网已断开，请重新连接；不会切换到移动数据。" }
    }

    private fun parseLanAddress(host: String): Inet4Address {
        require(Regex("^(?:0|[1-9]\\d{0,2})(?:\\.(?:0|[1-9]\\d{0,2})){3}$").matches(host)) { "仅允许局域网 IPv4 地址。" }
        val parts = host.split('.').map { it.toInt() }
        require(parts.all { it in 0..255 } && (
            parts[0] == 10 || (parts[0] == 172 && parts[1] in 16..31) ||
            (parts[0] == 192 && parts[1] == 168) || (parts[0] == 169 && parts[1] == 254 && parts[2] in 1..254)
        )) { "不允许向公网或回环地址传输照片。" }
        return InetAddress.getByAddress(parts.map { it.toByte() }.toByteArray()) as Inet4Address
    }

    private fun sameSubnet(local: Inet4Address, target: Inet4Address, prefix: Int): Boolean {
        fun number(address: Inet4Address) = address.address.fold(0L) { value, part -> (value shl 8) or (part.toLong() and 255) }
        val mask = (0xffffffffL shl (32 - prefix)) and 0xffffffffL
        val peer = number(target)
        val network = number(local) and mask
        return (peer and mask) == network && peer != network && peer != (network or (mask xor 0xffffffffL))
    }
}
