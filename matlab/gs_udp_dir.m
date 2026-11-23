function d = gs_udp_dir()
%GS_UDP_DIR Folder holding gs_udp.h. Evaluated at code generation time by groundStationTx.
d = fileparts(mfilename('fullpath'));
end
