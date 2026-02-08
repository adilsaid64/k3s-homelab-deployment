import * as pulumi from '@pulumi/pulumi';

export type ProxmoxRole =
    | "PVEAdmin"
    | "PVEVMAdmin"
    | "PVEVMUser"
    | "PVEDatastoreAdmin"
    | "PVEAuditor";


type DatacenterScope = {
    scope: "datacenter";
};

type PoolScope = {
    scope: "pool";
    poolId: pulumi.Input<string>;
};

export type ProxmoxGroupArgs = {
    groupId: pulumi.Input<string>;
    role: ProxmoxRole;
    provider: proxmoxve.Provider;
} & (DatacenterScope | PoolScope);


export class ProxmoxGroup extends pulumi.ComponentResource {
    groupId: pulumi.Output<string>;

    constructor(
        name: string,
        args: ProxmoxGroupArgs,
        opts?: pulumi.ComponentResourceOptions
    ) {
        super("custom:infra:ProxmoxGroup", name, {}, opts);

        const acl =
            args.scope === "datacenter"
                ? {
                    path: "/",
                    roleId: args.role,
                    propagate: true,
                }
                : {
                    path: pulumi.interpolate`/pool/${args.poolId}`,
                    roleId: args.role,
                    propagate: true,
                };

        const group = new proxmoxve.permission.Group(
            name,
            {
                groupId: args.groupId,
                acls: [acl],
            },
            {
                parent: this,
                provider: args.provider,
            }
        );

        this.groupId = group.groupId;
        this.registerOutputs({
            groupId: this.groupId,
        });
    }
}


export interface ProxmoxAccountArgs {
    userId: string;
    password: string
    groupIds: pulumi.Input<string>[];
    provider: proxmoxve.Provider;
}

export class ProxmoxAccount extends pulumi.ComponentResource {
    userId: pulumi.Output<string>;
    tokenId: pulumi.Output<string>;
    tokenSecret: pulumi.Output<string>;

    constructor(
        name: string,
        args: ProxmoxAccountArgs,
        opts?: pulumi.ComponentResourceOptions
    ) {
        super("custom:infra:ProxmoxAccount", name, {}, opts);

        const user = new proxmoxve.permission.User(
            name,
            {
                userId: args.userId,
                password: args.password,
                enabled: true,
                groups: args.groupIds,
            },
            {
                parent: this,
                provider: args.provider,
            }
        );

        const token = new proxmoxve.user.Token(
            `${name}-token`,
            {
                userId: user.userId,
                tokenName: "default",
            },
            {
                parent: this,
                provider: args.provider,
            }
        );

        this.userId = user.userId;
        this.tokenId = token.id;
        this.tokenSecret = pulumi.secret(token.value);

        this.registerOutputs();
    }
}