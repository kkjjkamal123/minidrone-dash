/* gs_udp.h - fire-and-forget UDP broadcast of ground station telemetry.
 *
 * Header-only so the Simulink build needs no extra source file. On Linux (the
 * Raspberry Pi) it broadcasts each packet on every IPv4 interface that has a
 * broadcast address, so any laptop on the same network receives it with no IP
 * setup. It never blocks and never fails the model: every error is ignored.
 * On any other platform (desktop simulation builds) it compiles to nothing.
 */
#ifndef GS_UDP_H
#define GS_UDP_H

#include <stdint.h>

#define GS_UDP_PORT 47800

#if defined(__linux__)
#include <arpa/inet.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

/* Strict -std=c99 builds hide these BSD names; the Linux values are fixed ABI. */
#ifndef IFF_UP
#define IFF_UP 0x1
#endif
#ifndef IFF_BROADCAST
#define IFF_BROADCAST 0x2
#endif
#ifndef IFF_LOOPBACK
#define IFF_LOOPBACK 0x8
#endif

#define GS_UDP_MAX_DST 8

static int gs_udp_sock = -1;
static struct sockaddr_in gs_udp_dst[GS_UDP_MAX_DST];
static int gs_udp_ndst = 0;
static time_t gs_udp_refreshed = 0;

static void gs_udp_add(uint32_t addr_be)
{
    int i;
    for (i = 0; i < gs_udp_ndst; i++) {
        if (gs_udp_dst[i].sin_addr.s_addr == addr_be) return;
    }
    if (gs_udp_ndst >= GS_UDP_MAX_DST) return;
    memset(&gs_udp_dst[gs_udp_ndst], 0, sizeof(gs_udp_dst[0]));
    gs_udp_dst[gs_udp_ndst].sin_family = AF_INET;
    gs_udp_dst[gs_udp_ndst].sin_port = htons(GS_UDP_PORT);
    gs_udp_dst[gs_udp_ndst].sin_addr.s_addr = addr_be;
    gs_udp_ndst++;
}

/* Re-read interfaces every few seconds: Wi-Fi may come up after the model starts. */
static void gs_udp_refresh(void)
{
    struct ifaddrs *list = NULL, *ifa;
    gs_udp_ndst = 0;
    if (getifaddrs(&list) == 0) {
        for (ifa = list; ifa != NULL; ifa = ifa->ifa_next) {
            if (ifa->ifa_addr == NULL || ifa->ifa_addr->sa_family != AF_INET) continue;
            if ((ifa->ifa_flags & IFF_UP) == 0 || (ifa->ifa_flags & IFF_LOOPBACK) != 0) continue;
            if ((ifa->ifa_flags & IFF_BROADCAST) == 0 || ifa->ifa_broadaddr == NULL) continue;
            gs_udp_add(((struct sockaddr_in *)ifa->ifa_broadaddr)->sin_addr.s_addr);
        }
        freeifaddrs(list);
    }
    if (gs_udp_ndst == 0) gs_udp_add(htonl(INADDR_BROADCAST));
}

static void gs_udp_send(const uint8_t *buf, int32_t len)
{
    int i;
    time_t now;
    if (gs_udp_sock < 0) {
        int on = 1;
        gs_udp_sock = socket(AF_INET, SOCK_DGRAM, 0);
        if (gs_udp_sock < 0) return;
        setsockopt(gs_udp_sock, SOL_SOCKET, SO_BROADCAST, &on, sizeof(on));
        fcntl(gs_udp_sock, F_SETFL, fcntl(gs_udp_sock, F_GETFL, 0) | O_NONBLOCK);
    }
    now = time(NULL);
    if (now - gs_udp_refreshed >= 3 || gs_udp_ndst == 0) {
        gs_udp_refresh();
        gs_udp_refreshed = now;
    }
    for (i = 0; i < gs_udp_ndst; i++) {
        (void)sendto(gs_udp_sock, buf, (size_t)len, MSG_DONTWAIT,
                     (const struct sockaddr *)&gs_udp_dst[i], sizeof(gs_udp_dst[i]));
    }
}

#else

static void gs_udp_send(const uint8_t *buf, int32_t len)
{
    (void)buf;
    (void)len;
}

#endif
#endif /* GS_UDP_H */
