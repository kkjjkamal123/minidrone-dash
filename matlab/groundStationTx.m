function groundStationTx(mask, pos, traj, dbg)
%#codegen
% Ground station telemetry: one UDP broadcast per guidance frame (5 Hz).
% Read-only tap on lineGuidance's inputs and outputs; it changes no flight signal.
% Packet layout is documented in groundstation/gs/protocol.py (2460 bytes).
% Sends only in the deployed Raspberry Pi build; in desktop simulation it does nothing.
persistent frame
if isempty(frame)
    frame = uint32(0);
end
frame = frame + uint32(1);

if coder.target('Rtw')
    pkt = zeros(1, 2460, 'uint8');
    pkt(1:4) = uint8([77 68 71 83]);           % 'MDGS'
    pkt(5) = uint8(1);                          % version
    pkt(9:12) = typecast(frame, 'uint8');

    v = zeros(1, 12, 'single');
    v(1:4) = single(pos(1:4));
    v(5:8) = single(traj(1:4));
    v(9:12) = single(dbg(1:4));
    pkt(13:60) = typecast(v, 'uint8');

    % 120x160 mask, column-major, 8 pixels per byte, LSB first
    for k = 1:2400
        b = uint8(0);
        for j = 1:8
            if mask((k - 1)*8 + j)
                b = bitor(b, bitshift(uint8(1), j - 1));
            end
        end
        pkt(60 + k) = b;
    end

    hdir = coder.const(@feval, 'gs_udp_dir');
    coder.updateBuildInfo('addIncludePaths', hdir);
    coder.updateBuildInfo('addIncludeFiles', 'gs_udp.h', hdir);
    coder.cinclude('gs_udp.h');
    coder.ceval('gs_udp_send', coder.rref(pkt), int32(2460));
end
end
