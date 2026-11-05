# NixOS VM test for the Nest host. The host node runs the real kestrel-host daemon, configured only through
# services.kestrel-nest (module host-module.nix), and boots the guest image built by guest-module.nix. The control node
# runs test-control.ts, a test-only stand-in for the control plane that speaks protocol/src/nest.ts. Every command
# (create, resume, setLimits, evict, ...) is issued by the test script through that control node.
#
# Run: nix build .#checks.x86_64-linux.nest -L
{ self, pkgs, system }:
let
  gib = 1024 * 1024 * 1024;
  hostId = "host-1";
  slug = "h1";
  domain = "nest.test";
  secretsDir = "/run/kestrel-test";
  # Test-only secret shared by the control and host nodes. It exists only in this test's store closure.
  hostSecret = "nest-test-host-secret-not-for-production";
  guestImage = self.packages.${system}.nest-guest;
  manifest = "${guestImage}/manifest.json";
in
pkgs.testers.runNixOSTest {
  name = "kestrel-nest";

  nodes.control =
    { pkgs, ... }:
    {
      networking.interfaces.eth1.ipv4.addresses = [
        {
          address = "203.0.113.10";
          prefixLength = 24;
        }
      ];
      networking.firewall.allowedTCPPorts = [ 9000 ];
      environment.systemPackages = [ pkgs.curl pkgs.jq ];
      systemd.services.kestrel-control = {
        description = "Test-only Nest control plane";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment = {
          HOST_ID = hostId;
          HOST_SECRET = hostSecret;
        };
        serviceConfig = {
          ExecStart = "${pkgs.bun}/bin/bun run ${./test-control.ts}";
          Restart = "always";
        };
      };
    };

  nodes.host =
    { pkgs, ... }:
    {
      imports = [ self.nixosModules.nest-host ];

      virtualisation = {
        memorySize = 6144;
        cores = 4;
        diskSize = 16384;
      };

      networking.interfaces.eth1.ipv4.routes = [
        {
          address = "203.0.113.10";
          prefixLength = 32;
        }
      ];

      services.kestrel-nest = {
        enable = true;
        inherit slug domain hostId;
        controlUrl = "ws://203.0.113.10:9000";
        meterUrl = "http://203.0.113.10:9000";
        backupIntervalMs = 60 * 1000;
        uplink = "eth1";
        cpuVendor = "intel";
        capacity = {
          vcpus = 4;
          memoryBytes = 4 * gib;
        };
        template = {
          maxVcpus = 2;
          maxMemoryBytes = 2 * gib;
        };
        hostSecretFile = "${secretsDir}/host-secret";
        volumeKeyFile = "${secretsDir}/volume.key";
        volumeStore = "file:///var/lib/kestrel-host/volumes";
        acme.dnsProvider = "cloudflare";
        nixCache.publicKey = "nest-test-1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      };

      # Ingress is exercised on the loopback listener only; no public TLS terminator in the test.
      services.caddy.enable = pkgs.lib.mkForce false;

      systemd.services.kestrel-test-secrets = {
        description = "Test-only host secrets, generated at boot";
        wantedBy = [ "multi-user.target" ];
        before = [ "kestrel-host.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          umask 077
          mkdir -p ${secretsDir}
          printf '%s' '${hostSecret}' > ${secretsDir}/host-secret
          head -c 32 /dev/urandom > ${secretsDir}/volume.key
        '';
      };

      environment.systemPackages = [
        pkgs.curl
        pkgs.jq
        pkgs.iproute2
        pkgs.nftables
        pkgs.util-linux
      ];
    };

  testScript = ''
    import json
    import shlex
    import time

    GIB = 1024 ** 3
    SLUG = "${slug}"
    DOMAIN = "${domain}"
    MANIFEST = "${manifest}"
    STATE = "/var/lib/kestrel-host"
    CONTROL = "http://127.0.0.1:9000"

    def post_command(name, body):
        control.succeed("printf '%s' " + shlex.quote(json.dumps(body)) + " > /tmp/" + name + ".json")
        return control.succeed(
            "curl -sS -X POST " + CONTROL + "/test/command -H 'content-type: application/json' --data-binary @/tmp/" + name + ".json"
        )

    def command(body):
        result = json.loads(post_command("cmd", body))
        assert "error" not in result, json.dumps(result)
        return result

    def expect_ok(body):
        result = command(body)
        assert result.get("ok") is True, json.dumps(result)
        return result

    def command_async(name, body):
        control.succeed("printf '%s' " + shlex.quote(json.dumps(body)) + " > /tmp/" + name + ".json")
        control.succeed(
            "(curl -sS -X POST " + CONTROL + "/test/command -H 'content-type: application/json' --data-binary @/tmp/" + name + ".json"
            + " > /tmp/" + name + ".out 2>&1; touch /tmp/" + name + ".done) >/dev/null 2>&1 &"
        )

    def control_state():
        return json.loads(control.succeed("curl -sS " + CONTROL + "/test/state"))

    def show(box):
        return json.loads(host.succeed("kestrel-host vm show " + box))

    def health(box):
        return host.succeed(
            "curl -s -o /dev/null -w '%{http_code}' --max-time 150 -H 'Host: " + box + "." + SLUG + "." + DOMAIN
            + "' http://127.0.0.1:8081/api/health || true"
        ).strip()

    def wait_for(what, predicate, timeout=600):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = predicate()
            if last:
                return last
            time.sleep(2)
        raise Exception("timed out waiting for " + what + " (last: " + repr(last) + ")")

    def box_limits(memory, vcpus=2):
        return {"maxVcpus": vcpus, "maxMemoryBytes": memory, "gpu": "none", "volumeBytes": GIB}

    def create_body(box):
        return {
            "_tag": "create",
            "boxId": box,
            "userId": "user-" + box,
            "vmId": "vm-" + box + "-1",
            "ownerEpoch": 1,
            "limits": box_limits(2 * GIB),
            "publicUrl": "https://" + box + "." + SLUG + "." + DOMAIN,
            "enrollToken": ("enroll-" + box).ljust(43, "x"),
        }

    def resume_body(box, ref, vm_id, epoch):
        return {
            "_tag": "resume",
            "boxId": box,
            "userId": "user-" + box,
            "vmId": vm_id,
            "ownerEpoch": epoch,
            "limits": box_limits(2 * GIB),
            "publicUrl": "https://" + box + "." + SLUG + "." + DOMAIN,
            "volumeRef": ref,
            "enrollToken": None,
        }

    start_all()

    # 1. Host connects, reports its image and an empty VM list; the template is built from the guest image.
    control.wait_for_unit("kestrel-control.service")
    host.wait_for_unit("kestrel-host.service", timeout=900)
    expected_image = host.succeed("jq -r .imageId " + MANIFEST).strip()
    hello = wait_for("host hello", lambda: control_state()["hello"], 900)
    assert hello["imageId"] == expected_image, (hello["imageId"], expected_image)
    assert hello["hostId"] == "${hostId}", hello
    host.succeed("test -f " + STATE + "/templates/" + expected_image + "/config.json")
    assert json.loads(host.succeed("kestrel-host vm list")) == [], "fresh host has VMs"

    # 2. Create a box: clone from the template, boot, and serve health through ingress.
    expect_ok(create_body("b1"))
    assert show("b1")["state"] == "running", show("b1")
    wait_for("b1 health", lambda: health("b1") == "200", 600)

    # 3. Clone while b1 keeps serving: b2 is created in the background while b1 is polled.
    command_async("create-b2", create_body("b2"))
    while control.execute("test -f /tmp/create-b2.done")[0] != 0:
        assert health("b1") == "200", "b1 went unhealthy during b2's clone"
        time.sleep(2)
    assert json.loads(control.succeed("cat /tmp/create-b2.out")).get("ok") is True
    wait_for("b2 health", lambda: health("b2") == "200", 600)

    # 4. Idle suspend, then wake-on-request: a request to a suspended box resumes it and gets a 200.
    expect_ok({"_tag": "suspend", "boxId": "b1", "ownerEpoch": 1})
    assert show("b1")["state"] == "suspended", show("b1")
    wait_for("b1 wake-on-request health", lambda: health("b1") == "200", 300)
    assert show("b1")["state"] == "running", show("b1")

    # 5. Live resize down then up; the VMM's reported memory follows the limit.
    expect_ok({"_tag": "setLimits", "boxId": "b1", "ownerEpoch": 1, "limits": box_limits(GIB, 1)})
    wait_for("b1 shrunk", lambda: show("b1")["limits"]["maxMemoryBytes"] == GIB, 60)
    assert health("b1") == "200", "b1 unhealthy after shrink"
    expect_ok({"_tag": "setLimits", "boxId": "b1", "ownerEpoch": 1, "limits": box_limits(2 * GIB, 2)})
    wait_for("b1 grown", lambda: show("b1")["limits"]["maxMemoryBytes"] == 2 * GIB, 60)
    assert health("b1") == "200", "b1 unhealthy after grow"

    # 6. Park b1: backed up to the store, then the local volume copy is removed (as on a host that never had it),
    #    so the resume below must restore from the backup rather than the local file.
    parked = expect_ok({"_tag": "park", "boxId": "b1", "ownerEpoch": 1})
    ref = parked["vm"]["volumeRef"]
    assert ref, parked
    assert show("b1")["state"] == "parked", show("b1")
    host.succeed("rm -f " + STATE + "/vms/b1/volume.raw")
    expect_ok(resume_body("b1", ref, "vm-b1-2", 1))
    assert show("b1")["state"] == "running", show("b1")
    wait_for("b1 health after lazy resume", lambda: health("b1") == "200", 600)

    # 7. Evict b2 (another host took ownership): local state goes, the backup stays in the store.
    wait_for("b2 backup", lambda: show("b2")["volumeRef"], 300)
    expect_ok({"_tag": "evict", "boxId": "b2", "ownerEpoch": 2})
    host.fail("kestrel-host vm show b2")
    host.fail("test -e " + STATE + "/vms/b2/volume.raw")
    host.succeed("test -n \"$(find /var/lib/kestrel-host/volumes -mindepth 1 -print -quit)\"")

    # 8. Guest network: the veth stands in for a tap with the guest's address. Allowed: the uplink, the depcache
    #    port on 169.254.0.1. Blocked: the spoofed source, private ranges, the host's ssh port, and host ping.
    host.succeed("ip netns add guest")
    host.succeed("ip link add kn-probe type veth peer name eth0g")
    host.succeed("ip link set eth0g netns guest")
    host.succeed("ip link set kn-probe up")
    host.succeed("ip netns exec guest ip link set lo up")
    host.succeed("ip netns exec guest ip link set eth0g up")
    host.succeed("ip netns exec guest ip addr add 10.77.250.2/24 dev eth0g")
    host.succeed("ip netns exec guest ip route add default via 169.254.0.1 dev eth0g onlink")
    host.succeed("ip route add 10.77.250.2/32 dev kn-probe")
    host.succeed("nft add element inet kestrel tap_addrs '{ \"kn-probe\" . 10.77.250.2 }'")

    host.succeed("ip netns exec guest ping -c1 -W3 203.0.113.10")
    host.succeed("ip netns exec guest ping -c1 -W3 -I 10.77.250.2 203.0.113.10")
    status, _ = host.execute("ip netns exec guest timeout 4 bash -c 'echo > /dev/tcp/169.254.0.1/3141'")
    assert status == 0, "depcache port unreachable from guest: " + str(status)

    host.succeed("ip netns exec guest ip addr add 10.77.250.77/24 dev eth0g")
    status, _ = host.execute("ip netns exec guest ping -c1 -W3 -I 10.77.250.77 203.0.113.10")
    assert status != 0, "spoofed source reached the uplink"
    status, _ = host.execute("ip netns exec guest timeout 4 bash -c 'echo > /dev/tcp/169.254.0.1/22'")
    assert status == 124, "host ssh port answered (status " + str(status) + ")"
    status, _ = host.execute("ip netns exec guest timeout 4 bash -c 'echo > /dev/tcp/192.168.1.1/80'")
    assert status == 124, "private range reachable (status " + str(status) + ")"
    status, _ = host.execute("ip netns exec guest ping -c1 -W3 169.254.0.1")
    assert status != 0, "host answered ping from guest"

    # 9. Host restart: the box comes back on its own, from disk.
    host.systemctl("restart kestrel-host.service")
    host.wait_for_unit("kestrel-host.service", timeout=300)
    wait_for("b1 health after host restart", lambda: health("b1") == "200", 600)
  '';
}
