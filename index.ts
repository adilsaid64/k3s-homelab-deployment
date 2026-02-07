import "dotenv/config";
import * as pulumi from "@pulumi/pulumi";
import * as proxmoxve from "@muhlba91/pulumi-proxmoxve";


const provider = new proxmoxve.Provider('proxmoxve', {
    endpoint: process.env.PROXMOX_VE_ENDPOINT,
    insecure: true,
    username: process.env.PROXMOX_VE_USERNAME,
    password: process.env.PROXMOX_VE_PASSWORD
})

const user = new proxmoxve.permission.User("user", {
    comment: "Managed by Pulumi",
    email: "user@pve",
    enabled: true,
    userId: "user@pve",
}, { provider: provider });


const userToken = new proxmoxve.user.Token("user_token", {
    comment: "Managed by Pulumi",
    expirationDate: "2033-01-01T22:00:00Z",
    tokenName: "tk1",
    userId: user.userId,
}, { provider: provider });